import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { WATERMARK_PNG_BASE64, WATERMARK_PNG_WIDTH, WATERMARK_PNG_HEIGHT } from "./watermark-asset";

const execFileAsync = promisify(execFile);

/** Frame rate of the recorded video; every input in the graph runs at it. */
const OUTPUT_FPS = 30;

// ffmpeg IS the recorder (it encodes simulator-server's frame stream straight
// to mp4), so resolve it from PATH first, then the usual package-manager
// prefixes for hosts where the tool-server's PATH is sanitized (launchd /
// login-shell differences).
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
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

export interface Dimensions {
  width: number;
  height: number;
}

interface WatermarkBox {
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Locate a binary on PATH, falling back to common install prefixes. */
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

/** Absolute path (or bare name) of the ffmpeg to record with; null if absent. */
export function resolveFfmpeg(): Promise<string | null> {
  return resolveBinary("ffmpeg", FFMPEG_FALLBACK_PATHS);
}

// yuv420p (what the encoder writes) subsamples chroma 2x, so crop/scale
// dimensions AND offsets must be even - otherwise ffmpeg rounds the video crop
// down to even while the rgba logo scales to the odd value, and maskedmerge
// aborts on the size mismatch. Snap everything to even.
const even = (n: number) => 2 * Math.round(n / 2);
// Rounds DOWN to even: used for the frame-fitting clamps, where rounding up
// could push the box one pixel past the frame edge.
const evenFloor = (n: number) => 2 * Math.floor(n / 2);

/** The bottom-left watermark rectangle in pixels (all even) for a frame size. */
export function computeWatermarkBox({ width, height }: Dimensions): WatermarkBox {
  // Cap the box to the frame so a pathological aspect ratio (a frame far wider
  // than tall keeps the logo aspect and would otherwise make the box taller
  // than the frame) can't yield a crop rectangle larger than the input —
  // ffmpeg's crop aborts (-22) on that and kills the whole recording. Real
  // device resolutions never hit the cap; the box sits well inside the frame.
  const w = Math.max(2, Math.min(even(width * WATERMARK_WIDTH_FRACTION), evenFloor(width)));
  const h = Math.max(2, Math.min(even(w / LOGO_ASPECT), evenFloor(height)));
  const margin = even(width * WATERMARK_MARGIN_FRACTION);
  const bottomMargin = even(width * WATERMARK_BOTTOM_MARGIN_FRACTION);
  const x = Math.max(0, Math.min(even(margin), evenFloor(width - w)));
  const y = Math.max(0, Math.min(even(height - h - bottomMargin), evenFloor(height - h)));
  return { w, h, x, y };
}

/**
 * The ffmpeg `-filter_complex` graph that stamps the adaptive-contrast corner
 * watermark as the capture is encoded. Input 0 is the live frame pipe, input 1
 * is the white logo PNG. The graph:
 *  - pins the base to the output frame rate;
 *  - scales the logo into the corner box and derives a near-black copy;
 *  - reads the background luma UNDER the box and, per pixel, keeps the white
 *    logo over dark areas and the near-black logo over light areas (maskedmerge)
 *    for maximum contrast against whatever is behind it;
 *  - fades the whole stamp to WATERMARK_OPACITY and overlays it.
 *
 * The logo (input 1) is opened looped, so it is an endless stream; `shortest=1`
 * on the overlay ends the graph when the capture's frame pipe closes. Every
 * input runs at OUTPUT_FPS so maskedmerge's per-frame streams stay in lockstep.
 */
export function buildWatermarkGraph(dims: Dimensions): string {
  // yuv420p (the encoder's pixel format) needs even output dimensions, and a
  // device whose native frame is odd on either axis (iPhone 16 / 15 Pro / 15 /
  // 14 Pro stream at 1179x2556) would otherwise reach libx264 with an odd size
  // and fail the whole encode. Even the base up front when needed, and derive
  // the box from the same evened size so the mask crop stays inside it. An
  // already-even frame keeps the graph unchanged.
  const evenW = evenFloor(dims.width);
  const evenH = evenFloor(dims.height);
  const { w, h, x, y } = computeWatermarkBox({ width: evenW, height: evenH });
  const evenCrop =
    evenW !== dims.width || evenH !== dims.height ? `,crop=${evenW}:${evenH}:0:0` : "";
  const span = MASK_LIGHT_MIN_LUMA - MASK_DARK_MAX_LUMA;
  // High where the background is dark (-> keep the white logo), low where light.
  const maskRamp = `lut=y='clip((${MASK_LIGHT_MIN_LUMA}-val)/${span}*255,0,255)'`;
  return [
    `[0:v]fps=${OUTPUT_FPS}${evenCrop},split=2[base][under]`,
    `[under]crop=${w}:${h}:${x}:${y},format=gray,${maskRamp},format=gbrap[mask]`,
    `[1:v]fps=${OUTPUT_FPS},format=rgba,scale=${w}:${h},split=2[white][darksrc]`,
    `[darksrc]colorchannelmixer=rr=${DARK_LOGO_LEVEL}:gg=${DARK_LOGO_LEVEL}:bb=${DARK_LOGO_LEVEL}[dark]`,
    `[white]format=gbrap[whitep]`,
    `[dark]format=gbrap[darkp]`,
    `[darkp][whitep][mask]maskedmerge,format=rgba,colorchannelmixer=aa=${WATERMARK_OPACITY}[stamp]`,
    `[base][stamp]overlay=${x}:${y}:shortest=1[out]`,
  ].join(";");
}

/**
 * Materialize the embedded logo PNG to a temp file for ffmpeg to read. The
 * random suffix keeps two recordings started in the same millisecond from
 * sharing (and deleting) one another's file.
 */
export async function writeLogoTemp(): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `argent-watermark-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  await fs.writeFile(file, Buffer.from(WATERMARK_PNG_BASE64, "base64"));
  return file;
}
