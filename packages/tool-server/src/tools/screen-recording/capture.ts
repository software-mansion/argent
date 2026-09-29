import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import type { LivePanel } from "../../utils/foldable";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";
import { waitForChildExit } from "../../utils/profiler-shared/lifecycle";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { takeReapedSession } from "../../utils/reaped-sessions";
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
import {
  buildWatermarkGraph,
  letterboxFilter,
  resolveFfmpeg,
  writeLogoTemp,
  type Dimensions,
} from "./watermark";
import { disablePointer, type PointerControl } from "./pointer-control";
import {
  startServerCapture,
  stopServerCapture,
  type ServerRecordingControl,
} from "./server-capture";

/**
 * Host-side screen capture: the fallback for simulator-server builds that
 * cannot record for themselves (see `server-capture.ts`, which is preferred
 * wherever it works). Frames still come from simulator-server — the same
 * backend `screenshot` and every input tool already use — but over its MJPEG
 * stream: we subscribe to it, pace the frames onto a fixed 30fps timeline, and
 * pipe them into a single ffmpeg process that encodes (and optionally
 * watermarks) straight to the final mp4.
 *
 * Pacing frames here rather than letting ffmpeg read the stream itself is what
 * makes the timeline honest: the device only emits a frame when the screen
 * CHANGES, so a still screen would otherwise collapse to a fraction of a second
 * of video (and ffmpeg, blocked on a silent socket, would not even answer a
 * stop signal promptly). Re-emitting the last frame on a wall-clock schedule
 * keeps video duration equal to real elapsed time; identical frames cost almost
 * nothing once encoded.
 */

const OUTPUT_FPS = 30;
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
/**
 * How often a recording of a foldable resolves which panel is live, while it
 * runs (the preview page polls its own route on a similar cadence; nothing
 * else in argent polls). A fold made outside argent is then in the video
 * within about a second of the hand-over.
 */
const PANEL_POLL_MS = 1_000;
/**
 * The panel the device just switched to has drawn (that is what made it
 * live), so its stream's first frame lands within a few hundred ms; a panel
 * that never draws again would leave the recording on the old stream.
 */
const PANEL_FIRST_FRAME_TIMEOUT_MS = 5_000;

/**
 * How a recording of a foldable follows the panel the device renders to. The
 * MJPEG stream is per panel and keeps one size for its lifetime, so following
 * a fold means closing one stream and opening another; the frames keep going
 * into the same ffmpeg, which letterboxes them into the first frame's size.
 */
export interface PanelFollow {
  /**
   * The panel the recording starts on, as resolved at start: the main screen
   * when nothing resolved it, which then counts as the first check that
   * failed, for stop's warning.
   */
  initial: LivePanel;
  /** The MJPEG stream of a panel. */
  streamUrlForScreen(screen: number): string;
  /**
   * Which panel the device renders to now, as every touch and capture
   * resolves it; `source: "unknown"` when nothing could say.
   */
  resolveLivePanel(): Promise<LivePanel>;
  /** Poll cadence; the default is {@link PANEL_POLL_MS}. */
  pollMs?: number;
}
/** Hold briefly after spawn so bad args fail the start instead of the stop. */
const START_FAILFAST_GRACE_MS = 800;
/** ffmpeg finalizes on stdin EOF (typically <100ms); bound the wait anyway. */
const FINALIZE_WAIT_MS = 20_000;
const SIGINT_WAIT_MS = 5_000;

export function ffmpegArgs(opts: {
  outputFile: string;
  logoFile: string | null;
  graph: string | null;
  /**
   * The first frame's size, which the whole video keeps; null when its JPEG
   * header could not be read.
   */
  canvas: Dimensions | null;
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
    // The still logo is looped so the graph has a logo frame for every video
    // frame; `shortest=1` in the graph ends the output with the capture.
    // `buildWatermarkGraph` letterboxes the base into the first frame's
    // evened size, so the yuv420p encoder below always gets a valid size.
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
    // libx264 directly. yuv420p rejects an odd width or height — a device whose
    // native resolution is odd on either axis (iPhone 16 / 15 Pro / 15 / 14 Pro
    // stream at 1179x2556) would fail the encode after the readiness grace and
    // leave a 0-byte file. Dropping the odd edge pixel leaves even frames
    // unchanged. The letterbox fits a frame of another size mid-stream (a
    // foldable's other panel) into the first frame's; ffmpeg left to itself
    // would stretch it to the encoder's size.
    args.push(
      "-vf",
      opts.canvas ? letterboxFilter(opts.canvas) : "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0"
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
  api.trimmedAnyFrames = false;

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
    // Read through the session, not the closure: a foldable's recording swaps
    // `api.frameStream` for the other panel's stream mid-capture.
    const frame = (api.frameStream ?? stream).latest ?? null;
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
        api.trimmedAnyFrames = true;
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

/**
 * Follow the panel a foldable renders to: resolve it on each tick, and when
 * the answer changes, move the capture onto that panel's stream. A tick that
 * resolves nothing leaves the capture where it is and is counted for stop's
 * warning. The old stream is closed only once the new one has delivered a
 * frame, so a stream that fails to open (or a panel that has not drawn yet)
 * costs nothing but a retry on the next tick; the recording never goes dark
 * on argent's account.
 */
function startPanelFollow(
  api: ScreenRecordingSessionApi,
  follow: PanelFollow,
  child: ReturnType<typeof spawn>
): void {
  let inFlight = false;
  api.panelPollTimer = setInterval(() => {
    if (inFlight || api.captureProcess !== child) return;
    inFlight = true;
    void (async () => {
      try {
        const live = await follow.resolveLivePanel();
        if (api.captureProcess !== child) return;
        if (live.source === "unknown") {
          api.panelReadFailures++;
          return;
        }
        const screen = live.screen;
        if (screen === api.activeScreen) return;
        const next = await openMjpegStream(
          follow.streamUrlForScreen(screen),
          STREAM_CONNECT_TIMEOUT_MS
        );
        try {
          await next.waitForFirstFrame(PANEL_FIRST_FRAME_TIMEOUT_MS);
        } catch (err) {
          next.close();
          throw err;
        }
        // The poll may have outlived the capture while the stream connected.
        if (api.captureProcess !== child || !api.pumpTimer) {
          next.close();
          return;
        }
        const previous = api.frameStream;
        api.frameStream = next;
        api.activeScreen = screen;
        api.panelSwitches++;
        previous?.close();
      } catch (err) {
        process.stderr.write(
          `[screen-recording ${api.deviceId.slice(0, 8)}] could not follow the device onto its ` +
            `other panel: ${err instanceof Error ? err.message : String(err)}; retrying\n`
        );
      } finally {
        inFlight = false;
      }
    })();
  }, follow.pollMs ?? PANEL_POLL_MS);
  api.panelPollTimer.unref?.();
}

/** Stop pacing and release the stream subscription; safe to call repeatedly. */
function stopPump(api: ScreenRecordingSessionApi): void {
  if (api.pumpTimer) {
    clearInterval(api.pumpTimer);
    api.pumpTimer = null;
  }
  if (api.panelPollTimer) {
    clearInterval(api.panelPollTimer);
    api.panelPollTimer = null;
  }
  if (api.frameStream) {
    // Preserve a real drop before dropping the reference: a stop that arrives
    // after the cap/crash already ran this teardown reads the error from here,
    // since `frameStream` (and its `error`) is gone by then. Our own clean
    // close reports no error, so this never manufactures a phantom drop.
    api.lastFrameStreamError = api.frameStream.error ?? api.lastFrameStreamError;
    api.frameStream.close();
    api.frameStream = null;
  }
}

/**
 * End the capture: stop producing frames and close ffmpeg's stdin, which is
 * what makes it write the mp4 trailer. Used by stop and by the time-limit cap,
 * so both finalize identically. Session teardown finalizes inline instead, with
 * a shorter grace (see DISPOSE_FINALIZE_GRACE_MS) — it owes the file no caller.
 */
function finalizeCapture(api: ScreenRecordingSessionApi): void {
  stopPump(api);
  const stdin = api.captureProcess?.stdin;
  if (stdin?.writable) stdin.end();
}

interface StartCaptureParams {
  streamUrl: string;
  timeLimitSeconds: number;
  watermark: boolean;
  trimStatic: boolean;
  pointer?: PointerControl;
  /** simulator-server's own recorder, preferred whenever the build exposes it. */
  server?: ServerRecordingControl;
  /** Set for a foldable: the capture then moves with the live panel. */
  followPanel?: PanelFollow;
}

/**
 * Record the device screen, preferring simulator-server's own recorder and
 * falling back to the host pipeline when the build has no recording endpoint.
 *
 * Both paths write to the same host path, chosen here so the result is the same
 * file either way — and so `outputFile` can be returned by start even though the
 * server picks its own path and only reveals it at stop.
 */
export async function startCapture(
  api: ScreenRecordingSessionApi,
  params: StartCaptureParams
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "screen_recording_start");
  // Set synchronously (no await between the assert and here) so an overlapping
  // start or stop is rejected instead of racing this one through the async
  // connect/spawn window. The finally clears it on EVERY exit — including a
  // synchronous throw — so a failed start cannot wedge the session.
  api.startPending = true;
  const outputFile = path.join(
    os.tmpdir(),
    `argent-screen-recording-${api.deviceId.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}.mp4`
  );
  try {
    if (params.server) {
      const started = await startServerCapture(api, {
        ...params,
        server: params.server,
        outputFile,
      });
      if (started) return started;
    }
    return await startCaptureLocked(api, { ...params, outputFile });
  } finally {
    api.startPending = false;
    api.pendingChild = null;
  }
}

async function startCaptureLocked(
  api: ScreenRecordingSessionApi,
  params: StartCaptureParams & { outputFile: string }
): Promise<StartRecordingResult> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    throw new FailureError(
      "`ffmpeg` was not found on PATH. Install a build with libx264 (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu) and retry.",
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_FFMPEG_NOT_FOUND,
        failure_stage: "screen_recording_resolve_ffmpeg",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "ffmpeg",
      }
    );
  }

  const outputFile = params.outputFile;
  const stream = await openMjpegStream(params.streamUrl, STREAM_CONNECT_TIMEOUT_MS);
  let logoFile: string | null = null;
  let watermarkSkipped: string | null = null;
  let child: ReturnType<typeof spawn>;
  try {
    // The first frame proves the device is drawing, and its JPEG header carries
    // the size the whole video keeps (the letterbox canvas) and the watermark
    // geometry — no ffprobe pass over a file that does not exist yet.
    const firstFrame = await stream.waitForFirstFrame(FIRST_FRAME_TIMEOUT_MS);
    const canvas = readJpegDimensions(firstFrame);
    let graph: string | null = null;
    if (params.watermark && canvas) {
      logoFile = await writeLogoTemp();
      graph = buildWatermarkGraph(canvas);
    } else if (params.watermark) {
      // Only an unreadable JPEG header gets here. Record anyway — a video
      // without the stamp beats no video — but say so rather than handing back
      // a silently unwatermarked file.
      watermarkSkipped = "the frame size could not be read from the video stream";
    }

    // No await between here and `api.pendingChild = child`: if dispose() ran
    // (shutdown, or a stop-all-simulator-servers teardown of this device) while
    // this start was suspended above, abort now rather than spawn an encoder the
    // teardown can no longer reap.
    assertNotDisposed(api, "screen_recording_start");
    child = spawn(ffmpeg, ffmpegArgs({ outputFile, logoFile, graph, canvas }), {
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
    // Readiness can resolve on its fail-fast timer alone: if dispose killed the
    // just-spawned child inside the grace but the death was observed after the
    // timer settled, this await still resolves. Abort here rather than stamp a
    // session for a capture dispose has already ended — the same window the
    // server path guards at its pointer-enable await.
    if (api.disposed) assertNotDisposed(api, "screen_recording_start");
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
  // Clear the previous capture's pointer-enable result: an end via the cap or an
  // encoder crash never runs stop's reset, so without this a `showTouches: false`
  // recording started afterwards would inherit a stale `pointerFailed` and warn
  // at stop about an overlay it never requested.
  api.pointerFailed = false;
  api.lastExitInfo = null;
  api.lastFrameStreamError = null;
  api.outputFile = outputFile;
  api.logoFile = logoFile;
  api.watermarkSkipped = watermarkSkipped;
  api.trimStatic = params.trimStatic;
  api.framesWritten = 0;
  api.captureProcess = child;
  api.frameStream = stream;
  api.activeScreen = params.followPanel?.initial.screen ?? null;
  api.panelSwitches = 0;
  api.panelReadFailures = params.followPanel?.initial.source === "unknown" ? 1 : 0;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  // A live capture makes any earlier teardown breadcrumb unreportable: this
  // recording's own stop will succeed, so nothing would ever consume it, and it
  // would be left to blame a much later, genuine "no active recording".
  takeReapedSession("screen-recording", api.deviceId);
  startPump(api, stream);
  if (params.followPanel) startPanelFollow(api, params.followPanel, child);

  // Arm the exit handler BEFORE the pointer-enable await below. readiness
  // already removed its own 'exit' listener, so if the encoder dies during that
  // await the death would go unobserved (Node never replays an 'exit' fired with
  // no listener) — a later stop would then hand back a truncated file with no
  // warning and the cap would misread the crash as a clean time-limit finish.
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

  if (params.pointer) {
    // Arm the touch visualizer before returning, so the very first interaction
    // is already drawn into the recording. Store the teardown first so a
    // shutdown (or a stop-all-simulator-servers teardown of this device) racing
    // this await still restores the overlay. Best-effort: a
    // failure only costs the touch markers, surfaced as a warning at stop.
    api.pointerDisable = params.pointer.disable;
    api.pointerFailed = !(await params.pointer.enable());

    // Enabling is the one suspension point left after the session is stamped,
    // exactly as on the server path: dispose runs its teardown and is done, and
    // a start resuming here would report as live a capture dispose has already
    // killed, and arm a cap timer no later stop or dispose can clear.
    if (api.disposed) assertNotDisposed(api, "screen_recording_start");
  }

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
    void disablePointer(api);
  }, params.timeLimitSeconds * 1_000);

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

  // `serverStop` is stamped only by a server-side start, so it also identifies
  // which side owns the recording being stopped.
  if (api.serverStop) return stopServerCapture(api);

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
  // Fall back to the error stopPump stashed if the cap/crash already tore the
  // stream down, so a drop that coincided with the cap is not silently lost.
  const streamError = api.frameStream?.error ?? api.lastFrameStreamError ?? null;
  const watermarkSkipped = api.watermarkSkipped;
  const pointerFailed = api.pointerFailed;
  const panelSwitches = api.panelSwitches;
  const panelReadFailures = api.panelReadFailures;
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
    if (streamError) {
      // Append rather than gate on `!warning`: a stream drop that coincided
      // with the cap/crash carries its own "may freeze" caveat on top of the
      // more specific cap/exit notice — both are useful, neither should mask
      // the other.
      warning = [
        warning,
        `The frame stream from simulator-server dropped during the recording (${streamError.message}); ` +
          `the video may freeze on its last received frame.`,
      ]
        .filter(Boolean)
        .join(" ");
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
    if (panelReadFailures > 0) {
      warning = [
        warning,
        `The panel the device renders to could not be resolved ${panelReadFailures} time(s) during ` +
          `the recording (at its start, and on its checks every second): neither the accessibility ` +
          `service nor CoreDevice answered. The recording stayed on its panel for those, so a ` +
          `fold made during them is in the video only from the next check that answered, and ` +
          `parts of it may be black.`,
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
    // Only surface the trim-only fields when trimming actually collapsed a
    // static stretch. Without this guard a continuously-animating recording
    // still reports a phantom trimmedMs of a frame or two purely from the
    // framesWritten-vs-wall-clock rounding gap, contradicting the "present only
    // when trimming applied" contract.
    const trimmedMs =
      trimStatic && wallClockMs !== null && api.trimmedAnyFrames
        ? Math.max(0, wallClockMs - durationMs!)
        : undefined;
    return {
      outputFile,
      sizeBytes: size,
      durationMs,
      ...(trimmedMs !== undefined ? { wallClockMs: wallClockMs!, trimmedMs } : {}),
      ...(panelSwitches > 0 ? { panelSwitches } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    // A stop only throws when the container is missing or empty
    // (statNonEmptyOutput). Drop that dead-weight 0-byte temp so a retry doesn't
    // orphan it — but ONLY when the file is genuinely empty/absent, so no
    // unexpected error can ever delete a real recording. Fail SAFE: cleanup is
    // gated on a thrown failure AND an empty file, never on "delete unless a
    // success flag was set" — a delete-by-default a later refactor (e.g. the
    // stacked trim work) could trip into wiping every finalized video.
    const empty = await fs
      .stat(outputFile)
      .then((s) => s.size === 0)
      .catch(() => false);
    if (empty) await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    // Always return the session to a startable state — a failed stat must not
    // wedge the next start behind "already active". This stop already finalized
    // the host file, so there is nothing a retried stop could recover — unlike
    // the server path, which keeps a recording recoverable when its finalize
    // request times out (see server-capture.ts).
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
    api.framesWritten = 0;
    api.trimmedAnyFrames = false;
    api.activeScreen = null;
    api.panelSwitches = 0;
    api.panelReadFailures = 0;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
    api.lastFrameStreamError = null;
    clearActiveScreenRecording(api.deviceId);
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
  }
}
