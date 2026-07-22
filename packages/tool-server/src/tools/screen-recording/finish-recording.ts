import { spawn } from "child_process";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// `simctl io recordVideo` and `adb screenrecord` both emit VARIABLE-framerate
// video: frames are produced when the screen changes, so static spans collapse
// and the timeline advances irregularly. Players and re-encoders stutter on
// that. Normalizing to a constant 30fps on the way out makes playback smooth
// everywhere; this is also the pass that overlays the watermark, so a recording
// is only ever re-encoded once.
const OUTPUT_FPS = 30;
// A 180s capture at native resolution is large; encoding is fast at veryfast
// but bound the wait so a wedged ffmpeg can't hang `screen-recording-stop`.
const FINISH_TIMEOUT_MS = 180_000;
// ffmpeg is optional (recording works without it); resolve from PATH first,
// then the usual package-manager prefixes for hosts where the tool-server's
// PATH is sanitized (launchd/login-shell differences).
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

export interface FinishResult {
  /** The file to hand back — the finished re-encode, or the raw capture on any fallback. */
  outputFile: string;
  /** True when ffmpeg re-encoded the capture (30fps + optional watermark). */
  applied: boolean;
  /** Whether the watermark overlay was drawn (only when applied AND requested). */
  watermarked: boolean;
  warning?: string;
}

async function resolveFfmpeg(): Promise<string | null> {
  try {
    await execFileAsync("/bin/sh", ["-c", "command -v ffmpeg"], { timeout: 2_000 });
    return "ffmpeg";
  } catch {
    // not on PATH
  }
  for (const p of FFMPEG_FALLBACK_PATHS) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * The corner watermark. For now a translucent PLACEHOLDER SQUARE in the
 * bottom-left, sized relative to the frame width so it scales with any device
 * resolution. This stands in for `assets/watermark.svg` ("Argent /
 * By @swmansion") until the final artwork is signed off — see that file.
 */
function watermarkFilter(): string {
  const box = "iw*0.16";
  const margin = "iw*0.03";
  const x = margin;
  const y = `ih-${box}-${margin}`;
  const fill = `drawbox=x=${x}:y=${y}:w=${box}:h=${box}:color=black@0.35:t=fill`;
  const border = `drawbox=x=${x}:y=${y}:w=${box}:h=${box}:color=white@0.5:t=3`;
  return `${fill},${border}`;
}

/** The `-vf` chain: always normalize framerate, add the watermark on request. */
export function buildVideoFilter(watermark: boolean): string {
  const filters = [`fps=${OUTPUT_FPS}`];
  if (watermark) filters.push(watermarkFilter());
  return filters.join(",");
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      reject(new Error(`ffmpeg timed out after ${FINISH_TIMEOUT_MS} ms`));
    }, FINISH_TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited (${signal ?? code}): ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Post-process a finished capture: normalize to a constant 30fps (kills the
 * variable-framerate stutter) and, when `watermark` is set, overlay the corner
 * watermark. Best-effort: if ffmpeg is missing or fails, the raw capture is
 * returned untouched with a warning — a recording is never lost to the
 * finishing step. On success the raw intermediate is removed.
 */
export async function finishRecording(
  rawFile: string,
  opts: { watermark: boolean }
): Promise<FinishResult> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    return {
      outputFile: rawFile,
      applied: false,
      watermarked: false,
      warning:
        "ffmpeg was not found, so the raw variable-framerate capture is returned without 30fps " +
        "normalization" +
        (opts.watermark ? " or the watermark" : "") +
        ". Install ffmpeg (e.g. `brew install ffmpeg`) to enable video finishing.",
    };
  }

  const finishedFile = rawFile.replace(/\.mp4$/i, "") + "-final.mp4";
  const args = [
    "-y",
    "-i",
    rawFile,
    "-vf",
    buildVideoFilter(opts.watermark),
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
    finishedFile,
  ];

  try {
    await runFfmpeg(ffmpeg, args);
    const stat = await fs.stat(finishedFile);
    if (stat.size === 0) throw new Error("ffmpeg produced an empty file");
    // The finished file is safe — drop the raw intermediate.
    await fs.rm(rawFile, { force: true }).catch(() => {});
    return { outputFile: finishedFile, applied: true, watermarked: opts.watermark };
  } catch (err) {
    await fs.rm(finishedFile, { force: true }).catch(() => {});
    return {
      outputFile: rawFile,
      applied: false,
      watermarked: false,
      warning:
        `Video finishing (30fps${opts.watermark ? " + watermark" : ""}) failed ` +
        `(${(err instanceof Error ? err.message : String(err)).slice(0, 140)}); ` +
        "returned the raw capture instead.",
    };
  }
}
