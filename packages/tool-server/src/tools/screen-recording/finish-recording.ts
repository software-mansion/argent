import { spawn } from "child_process";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { WATERMARK_PNG_BASE64, WATERMARK_PNG_WIDTH, WATERMARK_PNG_HEIGHT } from "./watermark-asset";

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
// ffmpeg/ffprobe are optional (recording works without them); resolve from PATH
// first, then the usual package-manager prefixes for hosts where the
// tool-server's PATH is sanitized (launchd/login-shell differences).
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];
const FFPROBE_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "/usr/bin/ffprobe",
];

// Watermark geometry, all relative to the frame WIDTH so it scales with any
// device resolution.
const WATERMARK_WIDTH_FRACTION = 0.286; // watermark width as a fraction of frame width
const WATERMARK_MARGIN_FRACTION = 0.03; // inset from the left edge
const WATERMARK_BOTTOM_MARGIN_FRACTION = 0.018; // inset from the bottom edge (sits a touch lower than the side inset)
const WATERMARK_OPACITY = 0.2; // 0.2 opaque == 80% transparent (per request)
// Native aspect ratio of the embedded logo PNG; drives the watermark height.
const LOGO_ASPECT = WATERMARK_PNG_WIDTH / WATERMARK_PNG_HEIGHT;
// Runtime recolor of the white logo into its near-black twin (RGB scale factor).
const DARK_LOGO_LEVEL = 0.08;
// Per-pixel contrast selection: at/below MIN the background is dark enough that
// the white logo wins fully; at/above MAX it is light enough that the near-black
// logo wins fully; the band between ramps smoothly so a straddling edge dithers
// rather than hard-cutting.
const MASK_DARK_MAX_LUMA = 90;
const MASK_LIGHT_MIN_LUMA = 165;

export interface FinishResult {
  /** The file to hand back - the finished re-encode, or the raw capture on any fallback. */
  outputFile: string;
  /** True when ffmpeg re-encoded the capture (30fps + optional watermark). */
  applied: boolean;
  /** Whether the watermark overlay was drawn (only when applied AND requested). */
  watermarked: boolean;
  warning?: string;
}

interface Dimensions {
  width: number;
  height: number;
}

interface WatermarkBox {
  w: number;
  h: number;
  x: number;
  y: number;
}

async function resolveBinary(name: string, fallbacks: string[]): Promise<string | null> {
  try {
    await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], { timeout: 2_000 });
    return name;
  } catch {
    // not on PATH
  }
  for (const p of fallbacks) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function probeDimensions(ffprobe: string, file: string): Promise<Dimensions | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        file,
      ],
      { timeout: 10_000 }
    );
    const [w, h] = stdout.trim().split(",").map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: Math.round(w), height: Math.round(h) };
  } catch {
    return null;
  }
}

// yuv420p (what simctl/screenrecord emit) subsamples chroma 2x, so crop/scale
// dimensions AND offsets must be even - otherwise ffmpeg rounds the video crop
// down to even while the rgba logo scales to the odd value, and maskedmerge
// aborts on the size mismatch. Snap everything to even.
const even = (n: number) => 2 * Math.round(n / 2);

/** The bottom-left watermark rectangle in pixels (all even) for a frame size. */
export function computeWatermarkBox({ width, height }: Dimensions): WatermarkBox {
  const w = Math.max(2, even(width * WATERMARK_WIDTH_FRACTION));
  const h = Math.max(2, even(w / LOGO_ASPECT));
  const margin = even(width * WATERMARK_MARGIN_FRACTION);
  const bottomMargin = even(width * WATERMARK_BOTTOM_MARGIN_FRACTION);
  const x = Math.max(0, Math.min(even(margin), even(width - w)));
  const y = Math.max(0, Math.min(even(height - h - bottomMargin), even(height - h)));
  return { w, h, x, y };
}

/**
 * The ffmpeg `-filter_complex` graph that stamps the adaptive-contrast corner
 * watermark. Input 0 is the video, input 1 is the white logo PNG. The graph:
 *  - normalizes the base to a constant 30fps;
 *  - scales the logo into the corner box and derives a near-black copy;
 *  - reads the background luma UNDER the box and, per pixel, keeps the white
 *    logo over dark areas and the near-black logo over light areas (maskedmerge)
 *    for maximum contrast against whatever is behind it;
 *  - fades the whole stamp to WATERMARK_OPACITY and overlays it.
 *
 * The logo (input 1) is opened looped, so it is an endless stream; `shortest=1`
 * on the overlay ends the graph when the finite video ends. Every input runs at
 * OUTPUT_FPS so maskedmerge's per-frame streams stay in lockstep.
 */
export function buildWatermarkGraph(dims: Dimensions): string {
  const { w, h, x, y } = computeWatermarkBox(dims);
  const span = MASK_LIGHT_MIN_LUMA - MASK_DARK_MAX_LUMA;
  // High where the background is dark (-> keep the white logo), low where light.
  const maskRamp = `lut=y='clip((${MASK_LIGHT_MIN_LUMA}-val)/${span}*255,0,255)'`;
  return [
    `[0:v]fps=${OUTPUT_FPS},split=2[base][under]`,
    `[under]crop=${w}:${h}:${x}:${y},format=gray,${maskRamp},format=gbrap[mask]`,
    `[1:v]fps=${OUTPUT_FPS},format=rgba,scale=${w}:${h},split=2[white][darksrc]`,
    `[darksrc]colorchannelmixer=rr=${DARK_LOGO_LEVEL}:gg=${DARK_LOGO_LEVEL}:bb=${DARK_LOGO_LEVEL}[dark]`,
    `[white]format=gbrap[whitep]`,
    `[dark]format=gbrap[darkp]`,
    `[darkp][whitep][mask]maskedmerge,format=rgba,colorchannelmixer=aa=${WATERMARK_OPACITY}[stamp]`,
    `[base][stamp]overlay=${x}:${y}:shortest=1[out]`,
  ].join(";");
}

const ENCODE_ARGS = [
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
];

/** ffmpeg args for the plain 30fps normalization pass (no watermark). */
function normalizeArgs(rawFile: string, outFile: string): string[] {
  return ["-y", "-i", rawFile, "-vf", `fps=${OUTPUT_FPS}`, ...ENCODE_ARGS, outFile];
}

/** ffmpeg args for the 30fps + adaptive-contrast watermark pass. */
function watermarkArgs(
  rawFile: string,
  logoFile: string,
  graph: string,
  outFile: string
): string[] {
  return [
    "-y",
    "-i",
    rawFile,
    // Loop the still logo into an endless input so maskedmerge has a logo frame
    // for every video frame; overlay's shortest=1 bounds the output length.
    "-framerate",
    String(OUTPUT_FPS),
    "-loop",
    "1",
    "-i",
    logoFile,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    ...ENCODE_ARGS,
    outFile,
  ];
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

/** Run an ffmpeg encode and assert it produced a non-empty file. */
async function encode(bin: string, args: string[], outFile: string): Promise<void> {
  await runFfmpeg(bin, args);
  const stat = await fs.stat(outFile);
  if (stat.size === 0) throw new Error("ffmpeg produced an empty file");
}

/** Materialize the embedded logo PNG to a temp file for ffmpeg to read. */
async function writeLogoTemp(): Promise<string> {
  const file = path.join(os.tmpdir(), `argent-watermark-${process.pid}-${Date.now()}.png`);
  await fs.writeFile(file, Buffer.from(WATERMARK_PNG_BASE64, "base64"));
  return file;
}

function shorten(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 140);
}

/**
 * Post-process a finished capture: normalize to a constant 30fps (kills the
 * variable-framerate stutter) and, when `watermark` is set, overlay the
 * adaptive-contrast corner watermark. Best-effort at every step - if ffmpeg is
 * missing or a pass fails, we degrade gracefully (watermark pass -> plain 30fps
 * -> raw capture) so a recording is never lost to the finishing step. On
 * success the raw intermediate is removed.
 */
export async function finishRecording(
  rawFile: string,
  opts: { watermark: boolean }
): Promise<FinishResult> {
  const ffmpeg = await resolveBinary("ffmpeg", FFMPEG_FALLBACK_PATHS);
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
  let watermarkNote = "";
  let logoFile: string | null = null;

  try {
    // Preferred path: 30fps + watermark. Needs ffprobe (for the frame size) and
    // the logo temp file; if either is unavailable, fall through to plain 30fps.
    if (opts.watermark) {
      const ffprobe = await resolveBinary("ffprobe", FFPROBE_FALLBACK_PATHS);
      const dims = ffprobe ? await probeDimensions(ffprobe, rawFile) : null;
      if (!dims) {
        watermarkNote = ffprobe ? "could not read the video dimensions" : "ffprobe was not found";
      } else {
        try {
          logoFile = await writeLogoTemp();
          const graph = buildWatermarkGraph(dims);
          await encode(ffmpeg, watermarkArgs(rawFile, logoFile, graph, finishedFile), finishedFile);
          await fs.rm(rawFile, { force: true }).catch(() => {});
          return { outputFile: finishedFile, applied: true, watermarked: true };
        } catch (err) {
          await fs.rm(finishedFile, { force: true }).catch(() => {});
          watermarkNote = shorten(err);
        }
      }
    }

    // Plain 30fps normalization (watermark not requested, or its pass failed).
    await encode(ffmpeg, normalizeArgs(rawFile, finishedFile), finishedFile);
    await fs.rm(rawFile, { force: true }).catch(() => {});
    return {
      outputFile: finishedFile,
      applied: true,
      watermarked: false,
      warning: watermarkNote
        ? `Normalized to 30fps but could not overlay the watermark (${watermarkNote}).`
        : undefined,
    };
  } catch (err) {
    await fs.rm(finishedFile, { force: true }).catch(() => {});
    return {
      outputFile: rawFile,
      applied: false,
      watermarked: false,
      warning:
        `Video finishing (30fps${opts.watermark ? " + watermark" : ""}) failed ` +
        `(${shorten(err)}); returned the raw capture instead.`,
    };
  } finally {
    if (logoFile) await fs.rm(logoFile, { force: true }).catch(() => {});
  }
}
