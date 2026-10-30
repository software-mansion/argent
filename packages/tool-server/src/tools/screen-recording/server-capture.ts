import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import {
  DISPOSE_SERVER_STOP_MS,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
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
 * Recording done by simulator-server itself: it reuses the frames it already
 * encodes for the live stream, so there is no host `ffmpeg` and one encode
 * instead of two. The host keeps only the session bookkeeping.
 */

/** simulator-server's recording endpoints, bound by the start tool. */
export interface ServerRecordingControl {
  /**
   * Resolves the finalizer for this recording, or null when the build has no
   * recording endpoint.
   */
  start(opts: {
    watermark: boolean;
    trimStatic: boolean;
    timeLimitSeconds: number;
  }): Promise<ServerRecordingStop | null>;
}

/** Finalizes one server-side recording and hands back the muxed video. */
type ServerRecordingStop = () => Promise<ServerRecordingResult>;

/** Called by {@link startCapture} after its admission guards. */
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

  // A dispose during the request could not see this recording; end it here.
  if (api.disposed) {
    await Promise.race([
      stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_SERVER_STOP_MS)),
    ]);
    assertNotDisposed(api, "screen_recording_start");
  }

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
  api.serverCapture = true;
  api.trimStatic = params.trimStatic;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds, true);
  takeReapedSession("screen-recording", api.deviceId);

  if (params.pointer) {
    api.pointerDisable = params.pointer.disable;
    api.pointerFailed = !(await params.pointer.enable());
    assertNotDisposed(api, "screen_recording_start");
  }

  // Mirrors the cap simulator-server enforces; the video stays there for stop.
  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
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
 * Fetch the muxed video out of simulator-server's session directory, which is
 * wiped when that server exits. Called by {@link stopCapture}.
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
  // Taken before the await so a dispose cannot issue a second stop.
  api.serverStop = null;

  // Only a timeout leaves the recording possibly still running, so only it is
  // retryable.
  let finalizeRequestFailed = false;

  try {
    if (api.recordingActive) {
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
    }
    let result: ServerRecordingResult;
    try {
      result = await stop();
    } catch (err) {
      finalizeRequestFailed = getFailureSignal(err)?.network_failure === "timeout";
      throw err;
    }
    try {
      await fs.copyFile(result.path, outputFile);
    } catch (err) {
      // A full disk can leave a truncated copy; only this copy writes the path.
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
      ...(result.trimmedMs !== null && result.trimmedMs > 0 && result.wallClockMs !== null
        ? { wallClockMs: result.wallClockMs, trimmedMs: result.trimmedMs }
        : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    const empty = await fs
      .stat(outputFile)
      .then((s) => s.size === 0)
      .catch(() => false);
    if (empty) await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (finalizeRequestFailed) {
      // Keep what a retried stop or dispose needs; the touch visualizer stays
      // armed until one of them ends the recording.
      api.stopPending = false;
      api.pendingRetrieval = true;
      api.serverStop = stop;
      markScreenRecordingFinalized(
        api.deviceId,
        "its stop request failed before simulator-server confirmed the hand-over"
      );
    } else {
      await disablePointer(api);
      api.recordingActive = false;
      api.stopPending = false;
      api.pendingRetrieval = false;
      api.serverStop = null;
      api.serverCapture = false;
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
}
