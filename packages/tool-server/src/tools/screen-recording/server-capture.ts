import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";
import type { ServerRecordingResult } from "../../utils/simulator-client";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { takeReapedSession } from "../../utils/reaped-sessions";
import {
  assertNotDisposed,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./session-guards";
import { disablePointer, type PointerControl } from "./pointer-control";

/**
 * Recording done by simulator-server itself. It already encodes every frame for
 * the live stream, with the touch overlay drawn in, so it can pace, trim,
 * watermark and mux the video without the frames ever leaving the process —
 * no MJPEG re-decode, no host `ffmpeg`, and one encode instead of two.
 *
 * The host keeps only the session bookkeeping the tools present: the admission
 * guards, the time-limit reminder, and the touch visualizer (which is a
 * server-global toggle argent owns for the life of a recording, exactly as on
 * the fallback path).
 */

/**
 * simulator-server's recording endpoints, bound to the resolved server by the
 * start tool. Mirrors {@link PointerControl}: capture code drives it without
 * depending on the sim-server client.
 */
export interface ServerRecordingControl {
  /**
   * Begin recording. Resolves the call that finalizes *this* recording, or null
   * when this simulator-server build has no recording endpoint — the caller's
   * cue to capture the frame stream host-side instead.
   *
   * It hands the finalizer back rather than exposing a bare `stop` because
   * simulator-server keys the stop to the id start returned, and refuses one
   * that names anything else.
   */
  start(opts: {
    watermark: boolean;
    trimStatic: boolean;
    timeLimitSeconds: number;
  }): Promise<ServerRecordingStop | null>;
}

/** Finalizes one server-side recording and hands back the muxed video. */
export type ServerRecordingStop = () => Promise<ServerRecordingResult>;

/**
 * Start a server-side recording and stamp the session, or return null if this
 * simulator-server cannot record. Called with `startPending` already set by
 * {@link startCapture}, so the admission guards have run.
 */
export async function startServerCapture(
  api: ScreenRecordingSessionApi,
  params: {
    server: ServerRecordingControl;
    outputFile: string;
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    pointer?: PointerControl;
  }
): Promise<StartRecordingResult | null> {
  assertNotDisposed(api, "screen_recording_start");
  const stop = await params.server.start({
    watermark: params.watermark,
    trimStatic: params.trimStatic,
    timeLimitSeconds: params.timeLimitSeconds,
  });
  if (!stop) return null;

  // The recording now exists inside simulator-server, which outlives this
  // process. If shutdown ran while that request was in flight, dispose's
  // teardown has already been and gone and will never see it — so end it here,
  // the way the fallback path reaps a child spawned in the same window.
  if (api.disposed) {
    await stop().catch(() => {});
    assertNotDisposed(api, "screen_recording_start");
  }

  // The recording is live — this session owns it now. Stamped only on success,
  // so a failed start never burns a previous capture's pending recovery.
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.pointerFailed = false;
  api.lastExitInfo = null;
  api.lastFrameStreamError = null;
  api.outputFile = params.outputFile;
  api.serverStop = stop;
  api.trimStatic = params.trimStatic;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  // As on the fallback path: a live capture makes an earlier teardown
  // breadcrumb unreportable, since this recording's own stop will succeed and
  // nothing would ever consume it — left behind, it would blame a much later,
  // genuine "no active recording".
  takeReapedSession("screen-recording", api.deviceId);

  if (params.pointer) {
    // Arm the touch visualizer before returning so the very first interaction is
    // already drawn in. Store the teardown first, so a shutdown racing this
    // await still restores the overlay.
    api.pointerDisable = params.pointer.disable;
    api.pointerFailed = !(await params.pointer.enable());

    // Enabling is the one suspension point left after the session is stamped, so
    // it needs the same guard the start request got: dispose runs its teardown
    // and is done, and a session that resumes here would report a live recording
    // dispose has already stopped, and arm a cap timer no later call can clear.
    if (api.disposed) assertNotDisposed(api, "screen_recording_start");
  }

  // simulator-server enforces the same cap and stops producing frames there; this
  // timer only mirrors it in the session, so the reminder flips to "ended, still
  // to retrieve" and a start-after-cap is rejected rather than silently
  // discarding the finished video. It must NOT stop the recording — the video is
  // handed over by `screen-recording-stop`, whenever that arrives.
  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    // Ownership guard: a newer capture may have stamped the session already.
    if (api.serverStop !== stop) return;
    api.recordingTimedOut = true;
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    void disablePointer(api);
  }, params.timeLimitSeconds * 1_000);

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile: params.outputFile,
  };
}

/**
 * Finalize a server-side recording: ask simulator-server for the muxed video and
 * move it out of the server's session directory, which is wiped when that
 * simulator-server exits. Called with `stopPending` already set by
 * {@link stopCapture}.
 */
export async function stopServerCapture(
  api: ScreenRecordingSessionApi
): Promise<StopRecordingFile> {
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const outputFile = api.outputFile!;
  const stop = api.serverStop!;
  const endedEarly = api.recordingTimedOut;
  const pointerFailed = api.pointerFailed;
  // Hand ownership over before the await: dispose decides whether to stop the
  // server's recording by looking at `serverStop`, and leaving it set across
  // this suspension lets a shutdown issue a second, concurrent stop for the
  // recording this call is already finalizing. That second stop also kills the
  // simulator-server whose session directory the copy below reads from.
  api.serverStop = null;

  try {
    if (api.recordingActive) {
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
    }
    const result = await stop();
    // Copy rather than reference: the video sits in simulator-server's temp
    // session directory, which disappears with that server — and the artifact is
    // materialized by the client afterwards, possibly downloaded over `argent
    // link` much later. Copy first, then drop the server's copy, so a failed
    // removal leaves a duplicate rather than no video at all.
    try {
      await fs.copyFile(result.path, outputFile);
    } catch (err) {
      // A copy that fails (a full disk, an unwritable destination) leaves the
      // only finished video inside simulator-server, where nothing here can
      // hand it over and the session directory takes it when that server
      // exits. Say where it is, so it can still be fetched while the server is
      // up — and classify it like the empty-output case two calls down, which
      // is the same outcome for the caller: no video at `outputFile`.
      //
      // Drop whatever the copy managed to write first. A full disk or a
      // file-size limit accepts the create and then refuses the rest, and the
      // truncated mp4 it leaves sits at the path `screen-recording-start`
      // handed the caller — nothing in this process reads it again, so the
      // corruption would only ever be found by whoever opens that path. The
      // outer catch cannot do it: its rule is to remove an output only when it
      // is genuinely empty, so no path can ever delete a real recording. Here
      // there is no such doubt — `outputFile` is unique per start and this copy
      // is the only thing that writes it, which is why the host fallback
      // removes its own on a failed start too.
      await fs.rm(outputFile, { force: true }).catch(() => {});
      const detail = err instanceof Error ? err.message : String(err);
      throw new FailureError(
        `The recording finished but could not be copied out of simulator-server: ${detail}. ` +
          `Until this simulator-server exits, the video is still at ${result.path}.`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
          failure_stage: "screen_recording_stop",
          failure_area: "tool_server",
          error_kind: "not_found",
          failure_command: "simulator_server",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    await fs.rm(result.path, { force: true }).catch(() => {});

    const warnings: string[] = [];
    if (endedEarly) {
      warnings.push(
        `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; returning the finalized video.`
      );
    }
    if (result.warning) warnings.push(result.warning);
    if (pointerFailed) {
      warnings.push(
        "The touch visualizer could not be enabled on simulator-server, so touches are not shown in this video."
      );
    }
    const warning = warnings.join(" ");

    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    return {
      outputFile,
      sizeBytes: size,
      durationMs: result.durationMs,
      // Only report the trim fields when trimming actually collapsed something,
      // matching the fallback path's contract.
      ...(result.trimmedMs !== null
        ? { wallClockMs: result.wallClockMs, trimmedMs: result.trimmedMs }
        : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    // Fail SAFE, as on the fallback path: only ever remove an output that is
    // genuinely empty or absent, never on a bare "something threw", so no code
    // path can delete a real recording.
    const empty = await fs
      .stat(outputFile)
      .then((s) => s.size === 0)
      .catch(() => false);
    if (empty) await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    // Always return the session to a startable state: a failed hand-off must not
    // wedge the next start behind "already active". simulator-server dropped its
    // recording when `stop` returned, so there is nothing a retry could recover.
    await disablePointer(api);
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.serverStop = null;
    api.outputFile = null;
    api.pointerFailed = false;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    clearActiveScreenRecording(api.deviceId);
  }
}
