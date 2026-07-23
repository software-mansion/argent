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

export const OUTPUT_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / OUTPUT_FPS;
/** Cap a catch-up burst so a stalled pipe cannot trigger a write storm. */
const MAX_CATCHUP_FRAMES = 5;
/** Skip a tick while ffmpeg is this far behind rather than buffering in Node. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const STREAM_CONNECT_TIMEOUT_MS = 10_000;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Hold briefly after spawn so bad args fail the start instead of the stop. */
const START_FAILFAST_GRACE_MS = 800;
/** ffmpeg finalizes on stdin EOF (typically <100ms); bound the wait anyway. */
const FINALIZE_WAIT_MS = 20_000;
const SIGINT_WAIT_MS = 5_000;

export function ffmpegArgs(opts: {
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
    // with the capture. `buildWatermarkGraph` already crops the base to even
    // dimensions, so the yuv420p encoder below always gets a valid size.
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
  } else {
    // No watermark graph to normalize the base, so the raw frame reaches
    // libx264 directly. yuv420p (4:2:0) subsamples chroma 2x and rejects an odd
    // width or height — a device whose native resolution is odd on either axis
    // (iPhone 16 / 15 Pro / 15 / 14 Pro stream at 1179x2556) would otherwise
    // fail the encode after the readiness grace and leave a 0-byte file that
    // stop reports as "the video file is empty". Drop the odd edge pixel so any
    // resolution encodes; even frames are unchanged.
    args.push("-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0");
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

function startPump(api: ScreenRecordingSessionApi, stream: MjpegStream): void {
  const child = api.captureProcess;
  const startedAt = api.wallClockStartMs ?? Date.now();
  let written = 0;
  api.pumpTimer = setInterval(() => {
    const stdin = child?.stdin;
    if (!stdin || !stdin.writable) return;
    const frame = stream.latest;
    if (!frame) return;
    // Never queue in Node: if ffmpeg is behind, drop this tick's frames and let
    // the counter catch up once it drains.
    if (stdin.writableLength > MAX_BUFFERED_BYTES) return;
    const missing = Math.min(framesDue(startedAt, Date.now()) - written, MAX_CATCHUP_FRAMES);
    for (let i = 0; i < missing; i++) {
      if (!stdin.writable) return;
      stdin.write(frame);
      written++;
    }
  }, FRAME_INTERVAL_MS);
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
  params: { streamUrl: string; timeLimitSeconds: number; watermark: boolean }
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
  params: { streamUrl: string; timeLimitSeconds: number; watermark: boolean }
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
  api.captureProcess = child;
  api.frameStream = stream;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  startPump(api, stream);

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
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    finalizeCapture(api);
  }, params.timeLimitSeconds * 1_000);

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
      markScreenRecordingFinalized(api.deviceId, "the recording process exited unexpectedly");
    }
  });

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile,
  };
}

/**
 * Resolve once ffmpeg has survived long enough to be considered live. It stays
 * silent on a good start, so "did not die within the grace" is the signal;
 * a bad filter graph or unwritable output dies immediately and fails the start.
 */
function waitForEncoderReady(
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
  const endedEarly = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  // Read before finalizing: closing the stream ourselves would look like a drop.
  const streamError = api.frameStream?.error ?? null;
  const watermarkSkipped = api.watermarkSkipped;
  let warning: string | undefined;
  let succeeded = false;

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

    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    // Capture length, not wall-clock-since-start: after the cap fires (or the
    // encoder dies) the recording is over even if stop arrives much later.
    const durationMs =
      startedAtMs === null ? null : (api.wallClockEndMs ?? Date.now()) - startedAtMs;
    const result = { outputFile, sizeBytes: size, durationMs, ...(warning ? { warning } : {}) };
    succeeded = true;
    return result;
  } finally {
    // Always return the session to a startable state — a failed stat must not
    // wedge the next start behind "already active". The video is host-side, so
    // unlike a device-side capture there is nothing a retried stop could
    // recover.
    stopPump(api);
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.captureProcess = null;
    api.outputFile = null;
    api.logoFile = null;
    api.watermarkSkipped = null;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
    clearActiveScreenRecording(api.deviceId);
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
    // A failed stop (missing/empty container) hands the caller no outputFile to
    // register, so the temp mp4 is dead weight — remove it rather than orphan a
    // 0-byte file in os.tmpdir on every retry. On success the file MUST survive:
    // screen-recording-stop registers it as an artifact after this returns.
    if (!succeeded) await fs.rm(outputFile, { force: true }).catch(() => {});
  }
}
