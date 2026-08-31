import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";
import { screenRecordStart, screenRecordStop } from "../../utils/sim-remote";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { takeReapedSession } from "../../utils/reaped-sessions";
import {
  assertNoActiveRecording,
  assertNotDisposed,
  assertStoppableSession,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./session-guards";
import { buildWatermarkGraph, resolveFfmpeg, resolveFfprobe, writeLogoTemp } from "./watermark";

/**
 * Screen capture for remote (`remote:`) simulators.
 *
 * Nothing is encoded here. A remote simulator's frames never reach this
 * machine as pictures — the local path's MJPEG stream has no analogue over MoQ
 * — so the recording is done where the device is: simulator-server buffers the
 * H264 frames it is already encoding, muxes them to an mp4 on the runner, and
 * `sim-remote screen-record stop` brings that file back. The whole capture is
 * therefore two CLI calls with a timer between them, not a live pipeline.
 *
 * What that costs, relative to `capture.ts`: the video arrives finished, so
 * watermarking and static-frame trimming are a post-pass over the downloaded
 * file rather than part of the encode — and both are best-effort, because a
 * host without ffmpeg can still be handed a perfectly good recording.
 */

const OUTPUT_FPS = 30;
/** Bound the post-pass so a wedged ffmpeg cannot hold the stop open. */
const POST_PASS_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

/**
 * `mpdecimate` drops frames identical to their predecessor and `setpts`
 * re-times what survives onto the output frame rate, collapsing a static
 * stretch. `fps` runs first on purpose: the runner's mp4 is variable-rate (a
 * still screen is one frame with a long duration, not a run of duplicates), so
 * the dead air has to be expanded into duplicate frames before anything can
 * drop them.
 *
 * The thresholds are far stricter than mpdecimate's defaults, which are tuned
 * for telecine and treat a slowly changing picture as a duplicate: at
 * `hi=64*12` a gentle animation loses half its frames and comes back stuttering.
 * At `hi=1` any visible change keeps the frame, which is as close as this gets
 * to the local pump's rule of dropping only byte-identical frames.
 *
 * Unlike that pump this keeps no grace period at the head of a still stretch —
 * the filter has no notion of one — so a pause collapses to about as long as
 * the encoder's own noise sustains rather than reading as a brief hold.
 */
const TRIM_FILTERS = `fps=${OUTPUT_FPS},mpdecimate=hi=1:lo=1:frac=1,setpts=N/${OUTPUT_FPS}/TB`;

function outputPath(deviceId: string, suffix = ""): string {
  return path.join(
    os.tmpdir(),
    `argent-screen-recording-${deviceId.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}${suffix}.mp4`
  );
}

export async function startRemoteCapture(
  api: ScreenRecordingSessionApi,
  params: {
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    showTouches: boolean;
  }
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "screen_recording_start");
  // Set synchronously (no await between the assert and here) so an overlapping
  // start or stop is rejected instead of racing this one through the async
  // window below; the finally clears it on every exit.
  api.startPending = true;
  try {
    // A dispose that ran while an earlier await suspended this start would no
    // longer be able to release a recording started after it.
    assertNotDisposed(api, "screen_recording_start");
    await screenRecordStart(api.deviceId, { showTouches: params.showTouches });
  } catch (err) {
    api.startPending = false;
    throw asStartFailure(err);
  }

  const outputFile = outputPath(api.deviceId);

  // The capture is live — this recording owns the session now. Stamped only on
  // success, so a failed start never burns a previous capture's pending
  // recovery (same contract as the local path).
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.watermarkSkipped = null;
  api.outputFile = outputFile;
  api.trimStatic = params.trimStatic;
  api.watermark = params.watermark;
  api.remoteFetch = null;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  // Lets a teardown release the runner-side buffer instead of leaving
  // simulator-server recording into a capture nobody will ever collect. The
  // download lands on the path this start already handed back, so what was
  // captured is salvageable rather than discarded — the teardown breadcrumb
  // points there.
  api.remoteRelease = async () => {
    await screenRecordStop(api.deviceId, outputFile).catch(() => {});
  };
  api.startPending = false;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  // This recording's own stop will succeed, so an earlier teardown breadcrumb
  // would never be consumed — and would later blame a genuine "no active
  // recording" on an unrelated teardown.
  takeReapedSession("screen-recording", api.deviceId);

  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    // Ownership guard: a newer capture may have stamped the session.
    if (api.outputFile !== outputFile) return;
    api.recordingTimedOut = true;
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    // Fetch at the cap rather than at stop: the runner is still recording
    // until this call, so waiting would let the video keep growing past the
    // limit the caller set. Errors are held for whoever calls stop.
    api.remoteFetch = screenRecordStop(api.deviceId, outputFile).catch((err: unknown) => {
      api.remoteFetchError = err instanceof Error ? err : new Error(String(err));
    });
  }, params.timeLimitSeconds * 1_000);

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile,
  };
}

export async function stopRemoteCapture(
  api: ScreenRecordingSessionApi
): Promise<StopRecordingFile> {
  assertStoppableSession(api, "screen_recording_stop");
  // Set synchronously so a concurrent stop or start is rejected while this one
  // finalizes (see assertStoppableSession / assertNoActiveRecording).
  api.stopPending = true;

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const rawFile = api.outputFile!;
  const startedAtMs = api.wallClockStartMs;
  const trimStatic = api.trimStatic;
  const watermark = api.watermark;
  const timedOut = api.recordingTimedOut;
  const pending = api.remoteFetch;
  let outputFile = rawFile;
  let warning: string | undefined;

  try {
    if (pending) {
      // The cap already ended the recording and started the download.
      await pending;
      if (api.remoteFetchError) throw api.remoteFetchError;
      warning =
        `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; ` +
        `returning the finalized video.`;
    } else {
      if (api.recordingActive) {
        api.recordingActive = false;
        api.wallClockEndMs = Date.now();
      }
      await screenRecordStop(api.deviceId, rawFile);
    }
    // The runner no longer holds anything to release.
    api.remoteRelease = null;

    await statNonEmptyOutput(rawFile, "screen_recording_stop");

    // How long the runner actually captured. Read off the downloaded file when
    // ffprobe is around — it is what the video says about itself, where the
    // session clock also counts the start and stop round-trips.
    const recordedMs =
      (await probeDurationMs(rawFile)) ??
      (startedAtMs === null ? null : (api.wallClockEndMs ?? Date.now()) - startedAtMs);

    const post = await postProcess({ rawFile, trimStatic, watermark });
    if (post.outputFile) outputFile = post.outputFile;
    if (post.warning) warning = [warning, post.warning].filter(Boolean).join(" ");

    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    // Only a rewritten video can differ in length from the recording; without a
    // post-pass the two are the same file.
    const finalMs = post.outputFile
      ? ((await probeDurationMs(outputFile)) ?? recordedMs)
      : recordedMs;
    // Reported only when trimming actually removed a stretch worth mentioning:
    // a continuously animating recording would otherwise show a phantom
    // trimmedMs of a frame or two from re-encoding.
    const trimmedMs =
      post.trimmed && finalMs !== null && recordedMs !== null && recordedMs - finalMs > 1_000
        ? recordedMs - finalMs
        : undefined;
    return {
      outputFile,
      sizeBytes: size,
      durationMs: finalMs,
      ...(trimmedMs !== undefined ? { wallClockMs: recordedMs!, trimmedMs } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    // Nothing usable came back, so the temp names are ours to clean up. Gated
    // on the file genuinely being empty or absent, never on "delete unless a
    // success flag was set", so no unexpected error can delete a real video.
    for (const file of new Set([rawFile, outputFile])) {
      const empty = await fs
        .stat(file)
        .then((s) => s.size === 0)
        .catch(() => true);
      if (empty) await fs.rm(file, { force: true }).catch(() => {});
    }
    throw timedOut ? asFetchAfterCapFailure(err, api.timeLimitSeconds) : err;
  } finally {
    // Always return the session to a startable state — a failed post-pass must
    // not wedge the next start behind "already active".
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.remoteRelease = null;
    api.remoteFetch = null;
    api.remoteFetchError = null;
    api.outputFile = null;
    api.watermarkSkipped = null;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    clearActiveScreenRecording(api.deviceId);
    // The raw download is superseded once a post-pass rewrote it.
    if (outputFile !== rawFile) await fs.rm(rawFile, { force: true }).catch(() => {});
  }
}

interface PostPassResult {
  /** The rewritten file, or null when the raw download is what the caller gets. */
  outputFile: string | null;
  /** Whether static-frame trimming actually ran. */
  trimmed: boolean;
  warning?: string;
}

/**
 * Watermark and/or trim the downloaded mp4 in one re-encode.
 *
 * Best-effort by design: unlike the local path, ffmpeg is not what produced
 * this video, so a host without it (or a pass that fails) still has a complete
 * recording to hand over — with a warning saying what was skipped, never a
 * silently plain file.
 */
async function postProcess(opts: {
  rawFile: string;
  trimStatic: boolean;
  watermark: boolean;
}): Promise<PostPassResult> {
  if (!opts.trimStatic && !opts.watermark) return { outputFile: null, trimmed: false };

  const wanted = [
    opts.trimStatic ? "dead air was not trimmed" : null,
    opts.watermark ? "the watermark was not applied" : null,
  ]
    .filter(Boolean)
    .join(" and ");

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    return {
      outputFile: null,
      trimmed: false,
      warning:
        `\`ffmpeg\` was not found on PATH, so ${wanted} — the recording itself is complete. ` +
        `Install it (e.g. \`brew install ffmpeg\`) to post-process remote recordings.`,
    };
  }

  // The watermark geometry is derived from the frame size, which only the
  // finished file knows.
  let graph: string | null = null;
  let logoFile: string | null = null;
  let warning: string | undefined;
  if (opts.watermark) {
    const dims = await probeDimensions(opts.rawFile);
    if (dims) {
      logoFile = await writeLogoTemp();
      graph = buildWatermarkGraph(dims);
    } else {
      warning = "The watermark was not applied (the video's frame size could not be read).";
    }
  }

  const outputFile = opts.rawFile.replace(/\.mp4$/, "-final.mp4");
  const args = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-i", opts.rawFile];
  if (logoFile && graph) {
    // The still logo is looped so the graph has a logo frame for every video
    // frame; `shortest=1` in the graph ends the output with the capture.
    args.push("-framerate", String(OUTPUT_FPS), "-loop", "1", "-i", logoFile, "-filter_complex");
    // The graph's own `fps` normalizes the timeline, so trimming has to happen
    // ahead of it, on the way into the graph.
    args.push(
      opts.trimStatic ? `[0:v]${TRIM_FILTERS}[src];${graph.replace("[0:v]", "[src]")}` : graph
    );
    args.push("-map", "[out]");
  } else {
    // yuv420p rejects an odd width or height, and a device whose native
    // resolution is odd on either axis (iPhone 16 / 15 Pro / 15 / 14 Pro) would
    // otherwise fail the encode. Dropping the odd edge pixel leaves even frames
    // unchanged.
    const crop = "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0";
    args.push("-vf", opts.trimStatic ? `${TRIM_FILTERS},${crop}` : crop);
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
    outputFile
  );

  try {
    await execFileAsync(ffmpeg, args, { timeout: POST_PASS_TIMEOUT_MS });
    await statNonEmptyOutput(outputFile, "screen_recording_post_process");
    return { outputFile, trimmed: opts.trimStatic, ...(warning ? { warning } : {}) };
  } catch (err) {
    await fs.rm(outputFile, { force: true }).catch(() => {});
    return {
      outputFile: null,
      trimmed: false,
      warning:
        `Post-processing the recording failed (${(err as Error).message.trim().slice(-200)}), so ` +
        `${wanted} — the recording itself is complete.`,
    };
  } finally {
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
  }
}

/** One `ffprobe -show_entries` read; null when ffprobe is absent or unhappy. */
async function probe(file: string, entries: string): Promise<string[] | null> {
  const ffprobe = await resolveFfprobe();
  if (!ffprobe) return null;
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        entries,
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" }
    );
    return String(stdout).trim().split(/\s+/);
  } catch {
    return null;
  }
}

async function probeDimensions(file: string): Promise<{ width: number; height: number } | null> {
  const values = await probe(file, "stream=width,height");
  if (!values || values.length < 2) return null;
  const [width, height] = values.map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width: width!, height: height! }
    : null;
}

async function probeDurationMs(file: string): Promise<number | null> {
  const values = await probe(file, "format=duration");
  const seconds = Number(values?.[0]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : null;
}

function asStartFailure(err: unknown): FailureError {
  // The disposed guard already carries the right code and explanation.
  if (err instanceof FailureError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FailureError(
    `Could not start recording the remote simulator's video stream: ${message}`,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE,
      failure_stage: "screen_recording_remote_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "sim_remote",
    },
    { cause: err instanceof Error ? err : new Error(String(err)) }
  );
}

/**
 * A cap-time fetch failure is worth its own message: the recording did end on
 * the runner, so re-running stop cannot bring it back and the caller should
 * record again rather than retry.
 */
function asFetchAfterCapFailure(err: unknown, timeLimitSeconds: number | null): FailureError {
  if (err instanceof FailureError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FailureError(
    `The recording hit its ${timeLimitSeconds ?? "?"}s time limit, but the video could not be ` +
      `retrieved from the remote simulator: ${message}. The recording has already ended there, ` +
      `so start a new one rather than retrying the stop.`,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
      failure_stage: "screen_recording_remote_fetch",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "sim_remote",
    },
    { cause: err instanceof Error ? err : new Error(String(err)) }
  );
}
