import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";
import { waitForChildExit } from "../../utils/profiler-shared/lifecycle";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { openMjpegStream, readJpegDimensions, type MjpegStream } from "./mjpeg-stream";
import {
  assertNoActiveRecording,
  assertNotDisposed,
  assertStoppableSession,
  clip,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./session-guards";
import { buildWatermarkGraph, resolveFfmpeg, writeLogoTemp } from "./watermark";

/**
 * Platform-agnostic screen capture, driven entirely by simulator-server — the
 * same backend `screenshot` and every input tool already use. simulator-server
 * publishes the device screen as an MJPEG stream; we subscribe to it, pace the
 * frames onto a fixed 30fps timeline, and pipe them into a single ffmpeg
 * process that encodes (and optionally watermarks) straight to the final mp4.
 *
 * Pacing frames here rather than letting ffmpeg read the stream itself is what
 * makes the timeline honest: the device only emits a frame when the screen
 * CHANGES, so a still screen would otherwise collapse to a fraction of a second
 * of video (and ffmpeg, blocked on a silent socket, would not even answer a
 * stop signal promptly). Re-emitting the last frame on a wall-clock schedule
 * keeps video duration equal to real elapsed time; identical frames cost almost
 * nothing once encoded.
 */

/**
 * Turns simulator-server's touch visualizer on for the life of a recording and
 * back off afterwards. Built by the start tool from the resolved sim-server
 * handle; capture.ts only arms it and stores the teardown, staying decoupled
 * from the sim-server client.
 */
export interface PointerControl {
  /** Enable the overlay; resolves false if the sim-server would not turn it on. */
  enable(): Promise<boolean>;
  /** Restore the overlay to off. Best-effort — never throws. */
  disable(): Promise<void>;
}

export const OUTPUT_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / OUTPUT_FPS;
/** Cap a catch-up burst so a stalled pipe cannot trigger a write storm. */
const MAX_CATCHUP_FRAMES = 5;
/** Skip a tick while ffmpeg is this far behind rather than buffering in Node. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
/**
 * How long a screen may sit unchanged before trimming kicks in. The first
 * second of every still stretch is kept so pauses read naturally; past it the
 * duplicate frames are dropped until the screen changes again. Only used when
 * `trimStatic` is on.
 */
const STATIC_GRACE_MS = 1_000;
const STREAM_CONNECT_TIMEOUT_MS = 10_000;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Hold briefly after spawn so bad args fail the start instead of the stop. */
const START_FAILFAST_GRACE_MS = 800;
/** ffmpeg finalizes on stdin EOF (typically <100ms); bound the wait anyway. */
const FINALIZE_WAIT_MS = 20_000;
const SIGINT_WAIT_MS = 5_000;

function ffmpegArgs(opts: {
  outputFile: string;
  logoFile: string | null;
  graph: string | null;
}): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    // The pump feeds whole JPEGs at a fixed cadence, so the input timeline is
    // exactly OUTPUT_FPS — no timestamp guessing, no variable-framerate stutter.
    "-f",
    "image2pipe",
    "-framerate",
    String(OUTPUT_FPS),
    "-i",
    "-",
  ];
  if (opts.logoFile && opts.graph) {
    // The still logo is looped into an endless input so the graph has a logo
    // frame for every video frame; `shortest=1` in the graph ends the output
    // with the capture.
    args.push(
      "-framerate",
      String(OUTPUT_FPS),
      "-loop",
      "1",
      "-i",
      opts.logoFile,
      "-filter_complex",
      opts.graph,
      "-map",
      "[out]"
    );
  }
  args.push(
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    "-y",
    opts.outputFile
  );
  return args;
}

/**
 * Wall-clock frame pacer. Each tick tops the encoder up to the frame count the
 * elapsed time calls for, so a late or coalesced timer callback self-corrects
 * instead of shortening the video.
 */
export function framesDue(startedAtMs: number, nowMs: number): number {
  // Multiply before dividing: `elapsed / (1000/30)` lands just under the whole
  // number at exact second boundaries (1000/33.333… = 29.999…), which would
  // drop one frame per second.
  return Math.floor(((nowMs - startedAtMs) * OUTPUT_FPS) / 1000);
}

/**
 * Whether two frames show the same picture. A cheap reference check short-
 * circuits the common "no new frame arrived" case (the stream hands back the
 * same Buffer object until it decodes a new one); only a genuinely new arrival
 * pays the byte compare, which — being exact — flags a change down to a single
 * pixel, matching the "even by a couple of pixels counts" intent. Byte equality
 * is stronger than a hash (no collisions) and native-fast.
 */
function sameFrame(a: Buffer | null, b: Buffer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.equals(b);
}

function startPump(api: ScreenRecordingSessionApi, stream: MjpegStream): void {
  const child = api.captureProcess;
  const trim = api.trimStatic;
  api.framesWritten = 0;

  // Pacing baseline. `framesDue(paceBaseMs, now) + paceBaseFrames` is the frame
  // count the wall clock calls for. In trim mode the baseline is re-anchored
  // every time a dead stretch is skipped, so the gap contributes no output
  // frames while active stretches still play back at real-time speed.
  let paceBaseMs = api.wallClockStartMs ?? Date.now();
  let paceBaseFrames = 0;
  // Trim bookkeeping: the last distinct picture and when it last changed.
  let lastFrame: Buffer | null = null;
  let lastChangeMs = paceBaseMs;
  let dead = false;

  api.pumpTimer = setInterval(() => {
    const stdin = child?.stdin;
    if (!stdin || !stdin.writable) return;
    const frame = stream.latest;
    if (!frame) return;
    // Never queue in Node: if ffmpeg is behind, drop this tick's frames and let
    // the counter catch up once it drains.
    if (stdin.writableLength > MAX_BUFFERED_BYTES) return;
    const now = Date.now();

    if (trim) {
      if (!sameFrame(frame, lastFrame)) {
        lastFrame = frame;
        lastChangeMs = now;
      }
      if (now - lastChangeMs > STATIC_GRACE_MS) {
        // Beyond the grace with no change: stop emitting. Nothing is written
        // until the screen moves again, collapsing the dead stretch.
        dead = true;
        return;
      }
      if (dead) {
        // Leaving a dead stretch: re-anchor pacing to now so the skipped gap
        // does not translate into a burst of catch-up frames.
        dead = false;
        paceBaseMs = now;
        paceBaseFrames = api.framesWritten;
      }
    }

    const target = paceBaseFrames + framesDue(paceBaseMs, now);
    const missing = Math.min(target - api.framesWritten, MAX_CATCHUP_FRAMES);
    for (let i = 0; i < missing; i++) {
      if (!stdin.writable) return;
      stdin.write(frame);
      api.framesWritten++;
    }
  }, FRAME_INTERVAL_MS);
}

/** Restore the touch visualizer to off. Best-effort, idempotent, never throws. */
export async function disablePointer(api: ScreenRecordingSessionApi): Promise<void> {
  const disable = api.pointerDisable;
  api.pointerDisable = null;
  if (disable) await disable().catch(() => {});
}

/** Stop pacing and release the stream subscription; safe to call repeatedly. */
function stopPump(api: ScreenRecordingSessionApi): void {
  if (api.pumpTimer) {
    clearInterval(api.pumpTimer);
    api.pumpTimer = null;
  }
  if (api.frameStream) {
    api.frameStream.close();
    api.frameStream = null;
  }
}

/**
 * End the capture: stop producing frames and close ffmpeg's stdin, which is
 * what makes it write the mp4 trailer. Used by stop, by the time-limit cap and
 * by session teardown, so all three finalize identically.
 */
function finalizeCapture(api: ScreenRecordingSessionApi): void {
  stopPump(api);
  const stdin = api.captureProcess?.stdin;
  if (stdin?.writable) stdin.end();
}

export async function startCapture(
  api: ScreenRecordingSessionApi,
  params: {
    streamUrl: string;
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    pointer?: PointerControl;
  }
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "screen_recording_start");
  // Set synchronously (no await between the assert and here) so an overlapping
  // start or stop is rejected instead of racing this one through the async
  // connect/spawn window. The finally clears it on EVERY exit — including a
  // synchronous throw — so a failed start cannot wedge the session.
  api.startPending = true;
  try {
    return await startCaptureLocked(api, params);
  } finally {
    api.startPending = false;
    api.pendingChild = null;
  }
}

async function startCaptureLocked(
  api: ScreenRecordingSessionApi,
  params: {
    streamUrl: string;
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    pointer?: PointerControl;
  }
): Promise<StartRecordingResult> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    throw new FailureError(
      "`ffmpeg` was not found on PATH. Install it (e.g. `brew install ffmpeg`) to record the screen.",
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_FFMPEG_NOT_FOUND,
        failure_stage: "screen_recording_resolve_ffmpeg",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "ffmpeg",
      }
    );
  }

  const outputFile = path.join(
    os.tmpdir(),
    `argent-screen-recording-${api.deviceId.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}.mp4`
  );

  const stream = await openMjpegStream(params.streamUrl, STREAM_CONNECT_TIMEOUT_MS);
  let logoFile: string | null = null;
  let watermarkSkipped: string | null = null;
  let child: ReturnType<typeof spawn>;
  try {
    // The first frame proves the device is actually drawing, and its JPEG
    // header carries the frame size the watermark geometry needs — no ffprobe
    // pass over a file that does not exist yet.
    const firstFrame = await stream.waitForFirstFrame(FIRST_FRAME_TIMEOUT_MS);
    const dims = params.watermark ? readJpegDimensions(firstFrame) : null;
    let graph: string | null = null;
    if (dims) {
      logoFile = await writeLogoTemp();
      graph = buildWatermarkGraph(dims);
    } else if (params.watermark) {
      // Only an unreadable JPEG header gets here. Record anyway — a video
      // without the stamp beats no video — but say so rather than handing back
      // a silently unwatermarked file.
      watermarkSkipped = "the frame size could not be read from the video stream";
    }

    // No await between here and `api.pendingChild = child`: if dispose() ran
    // (shutdown) while this start was suspended above, abort now rather than
    // spawn an encoder the teardown can no longer reap.
    assertNotDisposed(api, "screen_recording_start");
    child = spawn(ffmpeg, ffmpegArgs({ outputFile, logoFile, graph }), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    // Visible to dispose() while the fail-fast grace is pending (captureProcess
    // is stamped success-only).
    api.pendingChild = child;
  } catch (err) {
    stream.close();
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
    throw err;
  }

  const stderrRef = { text: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrRef.text = (stderrRef.text + chunk.toString("utf8")).slice(-4_000);
  });
  // An EPIPE on a dead encoder must not crash the tool-server.
  child.stdin?.on("error", () => {});

  try {
    await waitForEncoderReady(child, stderrRef);
  } catch (err) {
    stream.close();
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
    await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  }
  // A late exec error after readiness would otherwise be an unhandled 'error'.
  child.on("error", () => {});

  // The capture is live — this recording owns the session now. Stamping only on
  // success keeps a failed start from burning a previous capture's pending
  // recovery (same contract as the native-profiler start paths).
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.lastExitInfo = null;
  api.outputFile = outputFile;
  api.logoFile = logoFile;
  api.watermarkSkipped = watermarkSkipped;
  api.trimStatic = params.trimStatic;
  api.framesWritten = 0;
  api.captureProcess = child;
  api.frameStream = stream;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  startPump(api, stream);

  if (params.pointer) {
    // Arm the touch visualizer before returning, so the very first interaction
    // is already drawn into the recording. Store the teardown first so a
    // shutdown racing this await still restores the overlay. Best-effort: a
    // failure only costs the touch markers, surfaced as a warning at stop.
    api.pointerDisable = params.pointer.disable;
    api.pointerFailed = !(await params.pointer.enable());
  }

  superviseCapture(api, child, params.timeLimitSeconds);

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile,
  };
}

/**
 * Arm the auto-stop cap and the unexpected-exit handler for a live capture.
 * Shared by the MJPEG pump path and the MoQ push path — the cap and exit
 * handling are source-agnostic (they finalize ffmpeg and update session state,
 * never touch the frame source directly beyond `finalizeCapture`). Both handlers
 * carry an ownership guard so a superseded capture can't clobber a newer one.
 */
export function superviseCapture(
  api: ScreenRecordingSessionApi,
  child: ReturnType<typeof spawn>,
  timeLimitSeconds: number
): void {
  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    // Ownership guard: if a newer capture stamped the session, this timer is
    // stale and must not touch shared state.
    if (api.captureProcess !== child) return;
    api.recordingTimedOut = true;
    // Flip active BEFORE finalizing so the exit handler reads this as the cap,
    // not an unexpected death.
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${timeLimitSeconds}s time limit`);
    finalizeCapture(api);
    void disablePointer(api);
  }, timeLimitSeconds * 1_000);

  child.on("exit", (code, signal) => {
    // Ownership guard: after this capture is superseded, its exit must not
    // clobber the newer capture's session state.
    if (api.captureProcess !== child) return;
    api.lastExitInfo = { code, signal };
    api.captureProcess = null;
    if (api.recordingTimeout) {
      clearTimeout(api.recordingTimeout);
      api.recordingTimeout = null;
    }
    if (api.recordingActive) {
      // Died without stop or the cap: disk full, encoder crash, …
      api.recordingActive = false;
      api.recordingExitedUnexpectedly = true;
      api.wallClockEndMs = Date.now();
      api.pendingRetrieval = true;
      stopPump(api);
      void disablePointer(api);
      markScreenRecordingFinalized(api.deviceId, "the recording process exited unexpectedly");
    }
  });
}

/**
 * Resolve once ffmpeg has survived long enough to be considered live. It stays
 * silent on a good start, so "did not die within the grace" is the signal;
 * a bad filter graph or unwritable output dies immediately and fails the start.
 */
export function waitForEncoderReady(
  child: ReturnType<typeof spawn>,
  stderrRef: { text: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (err) reject(err);
      else resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new FailureError(
          `ffmpeg exited (${signal ? `signal ${signal}` : `code ${code ?? "?"}`}) before the ` +
            `recording started. stderr: ${clip(stderrRef.text)}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_START_EXITED,
            failure_stage: "screen_recording_encoder_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata({ code, signal }, "ffmpeg"),
          }
        )
      );
    };
    const onError = (err: Error) => {
      finish(
        new FailureError(
          `Failed to launch ffmpeg: ${err.message}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
            failure_stage: "screen_recording_encoder_spawn",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "ffmpeg"),
          },
          { cause: err }
        )
      );
    };
    const timer = setTimeout(() => finish(), START_FAILFAST_GRACE_MS);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function stopCapture(api: ScreenRecordingSessionApi): Promise<StopRecordingFile> {
  assertStoppableSession(api, "screen_recording_stop");
  // Set synchronously so a concurrent stop or start is rejected while this one
  // finalizes (see assertStoppableSession / assertNoActiveRecording).
  api.stopPending = true;

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const outputFile = api.outputFile!;
  const logoFile = api.logoFile;
  const startedAtMs = api.wallClockStartMs;
  const trimStatic = api.trimStatic;
  const endedEarly = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  // Read before finalizing: closing the stream ourselves would look like a drop.
  const streamError = api.frameStream?.error ?? null;
  const watermarkSkipped = api.watermarkSkipped;
  const pointerFailed = api.pointerFailed;
  const remoteTouchesUnsupported = api.remoteTouchesUnsupported;
  let warning: string | undefined;

  try {
    const child = api.captureProcess;
    if (api.recordingActive) {
      // Flip active first so the exit handler doesn't classify our own EOF as
      // an unexpected death. Frames stop here, so this is the recording's end.
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
    }
    // Idempotent: the cap may already have finalized this capture.
    finalizeCapture(api);

    if (child && !(await waitForChildExit(child, FINALIZE_WAIT_MS))) {
      // ffmpeg normally exits within milliseconds of stdin EOF; escalate only
      // if it is wedged, accepting that the container may be truncated.
      try {
        child.kill("SIGINT");
      } catch {
        // already dead
      }
      if (!(await waitForChildExit(child, SIGINT_WAIT_MS))) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        warning =
          "ffmpeg did not finalize the video after the capture ended and had to be killed; " +
          "the file may be truncated or unplayable.";
      }
    }

    if (endedEarly && !warning) {
      warning = api.recordingTimedOut
        ? `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; returning the finalized video.`
        : `ffmpeg exited before stop was called (code=${api.lastExitInfo?.code ?? "?"}, ` +
          `signal=${api.lastExitInfo?.signal ?? "?"}); returning whatever was captured.`;
    }
    if (streamError && !warning) {
      warning =
        `The frame stream from simulator-server dropped during the recording (${streamError.message}); ` +
        `the video may freeze on its last received frame.`;
    }

    if (watermarkSkipped) {
      warning = [warning, `The watermark was not applied (${watermarkSkipped}).`]
        .filter(Boolean)
        .join(" ");
    }
    if (pointerFailed) {
      warning = [
        warning,
        "The touch visualizer could not be enabled on simulator-server, so touches are not shown in this video.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (remoteTouchesUnsupported) {
      warning = [
        warning,
        "The touch visualizer is not available over the remote (MoQ) transport, so touches are not shown in this video.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    // Wall-clock capture length: after the cap fires (or the encoder dies) the
    // recording is over even if stop arrives much later.
    const wallClockMs =
      startedAtMs === null ? null : (api.wallClockEndMs ?? Date.now()) - startedAtMs;
    // durationMs is the length of the video the caller actually gets. With
    // trimming that is shorter than the wall clock — it counts only the frames
    // that survived (each output frame is 1/OUTPUT_FPS of a second).
    const durationMs = trimStatic
      ? Math.round((api.framesWritten / OUTPUT_FPS) * 1_000)
      : wallClockMs;
    const trimmedMs =
      trimStatic && wallClockMs !== null ? Math.max(0, wallClockMs - durationMs!) : undefined;
    return {
      outputFile,
      sizeBytes: size,
      durationMs,
      ...(trimmedMs !== undefined ? { wallClockMs: wallClockMs!, trimmedMs } : {}),
      ...(warning ? { warning } : {}),
    };
  } finally {
    // Always return the session to a startable state — a failed stat must not
    // wedge the next start behind "already active". The video is host-side, so
    // unlike a device-side capture there is nothing a retried stop could
    // recover.
    stopPump(api);
    await disablePointer(api);
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.captureProcess = null;
    api.outputFile = null;
    api.logoFile = null;
    api.watermarkSkipped = null;
    api.pointerFailed = false;
    api.remoteTouchesUnsupported = false;
    api.framesWritten = 0;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
    clearActiveScreenRecording(api.deviceId);
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
  }
}
