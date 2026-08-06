import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { spawn } from "child_process";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";
import { registerActiveScreenRecording } from "../../utils/screen-recording-reminder";
import {
  assertNoActiveRecording,
  assertNotDisposed,
  type StartRecordingResult,
} from "./session-guards";
import {
  FIRST_FRAME_TIMEOUT_MS,
  MAX_BUFFERED_BYTES,
  OUTPUT_FPS,
  superviseCapture,
  waitForEncoderReady,
} from "./capture";
import { buildWatermarkGraph, resolveFfmpeg, writeLogoTemp, type Dimensions } from "./watermark";
import type { MoqVideoStream } from "./moq-video-stream";

/**
 * Screen capture for a `sim-remote` device, driven by simulator-server's MoQ
 * "video" track instead of the local HTTP MJPEG stream (which a remote sim does
 * not expose). The track is an H.264 (Annex-B) elementary stream; this module
 * pipes it straight into `ffmpeg -f h264`, the same encoder+watermark backend
 * the local path uses — so once ffmpeg has the frames, watermarking, format and
 * finalization are identical, and `stopCapture` (host-side, source-agnostic)
 * retrieves the video unchanged.
 *
 * Unlike the MJPEG path there is no Node-side frame pump: frames are pushed to
 * ffmpeg as they arrive, and `-use_wallclock_as_timestamps` plus a constant
 * output rate hold each picture until the next one lands. That reconstructs a
 * still stretch BETWEEN two changes at its true length, but not one that runs
 * to the end of the recording: cfr can only hold a frame up to the next packet,
 * and on a still screen no packet follows, so the video ends at the last change.
 * `stop` reports that end as `durationMs` and warns when it is well short of
 * the wall clock. `trimStatic` does not apply here for the same reason — there
 * are no duplicate frames to collapse.
 *
 * The touch visualizer is not available over MoQ (the control channel carries
 * no pointer command).
 */

const DIMENSION_PROBE_TIMEOUT_MS = 4_000;

export interface StartMoqCaptureParams {
  /**
   * Opens the MoQ video stream. A factory (not the stream itself) so the connect
   * happens inside the start's disposed/active guards, and so tests can inject a
   * stream against a locally-run moq server without the orchestrator round-trip.
   */
  openStream: () => Promise<MoqVideoStream>;
  timeLimitSeconds: number;
  watermark: boolean;
  /**
   * Whether the caller asked for the touch visualizer. It is not available over
   * MoQ, so this only drives the "touches won't be shown" warning at stop.
   */
  showTouchesRequested: boolean;
}

/**
 * Feed Annex-B access units to ffmpeg under back-pressure, returning whether the
 * unit was written.
 *
 * Never queue in Node: if ffmpeg is behind, stop writing until it drains, as the
 * MJPEG pump does. What cannot be borrowed from that pump is how to resume.
 * JPEG frames are independent, so it simply writes the next one. An H.264 access
 * unit is not: every following P-frame is coded against the units before it, so
 * resuming mid-GOP hands the decoder references it never received and the output
 * stays broken until the next keyframe. Skip forward to that boundary instead —
 * a lost second of video in exchange for a stream that decodes.
 */
export function createAnnexbWriter(io: {
  isWritable: () => boolean;
  bufferedBytes: () => number;
  write: (annexb: Buffer) => void;
  maxBufferedBytes?: number;
}): (annexb: Buffer, keyframe: boolean) => boolean {
  const max = io.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  let resyncing = false;
  return (annexb: Buffer, keyframe: boolean): boolean => {
    if (!io.isWritable()) return false;
    if (io.bufferedBytes() > max) {
      resyncing = true;
      return false;
    }
    if (resyncing) {
      if (!keyframe) return false;
      resyncing = false;
    }
    io.write(annexb);
    return true;
  };
}

/** ffprobe path derived from the resolved ffmpeg path (they ship together). */
function ffprobeFor(ffmpeg: string): string {
  if (ffmpeg === "ffmpeg") return "ffprobe";
  const dir = path.dirname(ffmpeg);
  return path.join(dir, path.basename(ffmpeg).replace(/ffmpeg$/, "ffprobe"));
}

/**
 * Read the video dimensions from a single H.264 keyframe (its in-band SPS) via
 * ffprobe. Best-effort: the watermark geometry needs the frame size, but an
 * unreadable probe just skips the stamp rather than failing the recording.
 */
function probeH264Dimensions(ffprobe: string, keyframe: Buffer): Promise<Dimensions | null> {
  return new Promise((resolve) => {
    const child = execFile(
      ffprobe,
      [
        "-v",
        "error",
        "-f",
        "h264",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        "pipe:0",
      ],
      { timeout: DIMENSION_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: Array<{ width?: number; height?: number }>;
          };
          const s = parsed.streams?.[0];
          if (s?.width && s?.height) return resolve({ width: s.width, height: s.height });
        } catch {
          // fall through
        }
        resolve(null);
      }
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(keyframe);
  });
}

function moqFfmpegArgs(opts: {
  outputFile: string;
  logoFile: string | null;
  graph: string | null;
}): string[] {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    // The server emits a frame only when the screen changes, each already
    // timestamped in real time. Stamp packets with their arrival wall-clock and
    // resample to a constant rate so a still screen is held (honest timeline)
    // rather than collapsing — the H.264 counterpart of the MJPEG pump.
    "-use_wallclock_as_timestamps",
    "1",
    "-f",
    "h264",
    "-i",
    "pipe:0",
  ];
  if (opts.logoFile && opts.graph) {
    args.push("-framerate", String(OUTPUT_FPS), "-loop", "1", "-i", opts.logoFile);
    args.push("-filter_complex", opts.graph, "-map", "[out]");
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
    "-fps_mode",
    "cfr",
    "-r",
    String(OUTPUT_FPS),
    "-movflags",
    "+faststart",
    "-an",
    "-y",
    opts.outputFile
  );
  return args;
}

export async function startMoqCapture(
  api: ScreenRecordingSessionApi,
  params: StartMoqCaptureParams
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "screen_recording_start");
  api.startPending = true;
  try {
    return await startMoqCaptureLocked(api, params);
  } finally {
    api.startPending = false;
    api.pendingChild = null;
  }
}

async function startMoqCaptureLocked(
  api: ScreenRecordingSessionApi,
  params: StartMoqCaptureParams
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

  const stream = await params.openStream();
  let logoFile: string | null = null;
  let watermarkSkipped: string | null = null;
  let child: ReturnType<typeof spawn>;
  try {
    // The first keyframe proves the remote device is drawing and carries the SPS
    // the watermark geometry reads its dimensions from.
    const firstFrame = await stream.waitForFirstFrame(FIRST_FRAME_TIMEOUT_MS);
    let graph: string | null = null;
    if (params.watermark) {
      const dims = await probeH264Dimensions(ffprobeFor(ffmpeg), firstFrame);
      if (dims) {
        logoFile = await writeLogoTemp();
        graph = buildWatermarkGraph(dims);
      } else {
        // Record anyway — a video without the stamp beats no video — but say so.
        watermarkSkipped = "the frame size could not be read from the MoQ video stream";
      }
    }

    assertNotDisposed(api, "screen_recording_start");
    child = spawn(ffmpeg, moqFfmpegArgs({ outputFile, logoFile, graph }), {
      stdio: ["pipe", "ignore", "pipe"],
    });
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
  child.stdin?.on("error", () => {});

  try {
    await waitForEncoderReady(child, stderrRef);
  } catch (err) {
    stream.close();
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
    await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  }
  child.on("error", () => {});

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
  // Nothing to trim: the encoder never emits the duplicate frames trimming
  // collapses, so the stop path must not treat this as a trimmed capture.
  // `lastFrameWrittenMs` is what keeps its duration honest instead.
  api.trimStatic = false;
  api.remoteTouchesUnsupported = params.showTouchesRequested;
  api.framesWritten = 0;
  api.captureProcess = child;
  api.frameStream = stream;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);

  // Push frames as they arrive, replaying any buffered before this attaches so
  // the leading keyframe is fed.
  const writeFrame = createAnnexbWriter({
    isWritable: () => Boolean(child.stdin?.writable),
    bufferedBytes: () => child.stdin?.writableLength ?? 0,
    write: (annexb) => child.stdin!.write(annexb),
  });
  stream.onFrame((annexb, keyframe) => {
    if (!writeFrame(annexb, keyframe)) return;
    api.framesWritten++;
    // Where the video actually ends: nothing arrives while the screen is still,
    // and cfr cannot hold the last picture past it. `stop` reports this rather
    // than the wall clock, which the file would not cover.
    api.lastFrameWrittenMs = Date.now();
  });

  superviseCapture(api, child, params.timeLimitSeconds);

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile,
  };
}
