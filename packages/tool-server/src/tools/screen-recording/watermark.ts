import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { WATERMARK_PNG_BASE64, WATERMARK_PNG_WIDTH, WATERMARK_PNG_HEIGHT } from "./watermark-asset";

const execFileAsync = promisify(execFile);

/** Frame rate of the recorded video; every input in the graph runs at it. */
const OUTPUT_FPS = 30;

// Package-manager prefixes, for hosts where the tool-server's PATH is
// sanitized (launchd / login-shell differences).
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

// Watermark geometry, all relative to the frame WIDTH so it scales with any
// device resolution.
const WATERMARK_WIDTH_FRACTION = 0.286;
const WATERMARK_MARGIN_FRACTION = 0.03; // left inset
const WATERMARK_BOTTOM_MARGIN_FRACTION = 0.018; // bottom inset
const WATERMARK_OPACITY = 0.2;
// Native aspect ratio of the embedded logo PNG; drives the watermark height.
const LOGO_ASPECT = WATERMARK_PNG_WIDTH / WATERMARK_PNG_HEIGHT;
// Near-black twin of the white logo (RGB scale factor).
const DARK_LOGO_LEVEL = 0.08;
// Per-pixel contrast selection: below the dark max the white logo wins fully,
// above the light min the near-black one does, and the band between ramps.
const MASK_DARK_MAX_LUMA = 90;
const MASK_LIGHT_MIN_LUMA = 165;

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

// yuv420p subsamples chroma 2x, so crop/scale dimensions AND offsets must be
// even: on an odd value ffmpeg rounds the video crop down but scales the rgba
// logo to the odd value, and maskedmerge aborts on the size mismatch.
const even = (n: number) => 2 * Math.round(n / 2);
// Rounds DOWN, for the frame-fitting clamps where rounding up could push the
// box one pixel past the frame edge.
const evenFloor = (n: number) => 2 * Math.floor(n / 2);

/** The bottom-left watermark rectangle in pixels (all even) for a frame size. */
export function computeWatermarkBox({ width, height }: Dimensions): WatermarkBox {
  // Cap the box to the frame: a frame far wider than tall keeps the logo aspect
  // and would give a box taller than the frame, and ffmpeg's crop aborts on a
  // rectangle larger than its input. Real device resolutions never hit the cap.
  const w = Math.max(2, Math.min(even(width * WATERMARK_WIDTH_FRACTION), evenFloor(width)));
  const h = Math.max(2, Math.min(even(w / LOGO_ASPECT), evenFloor(height)));
  const margin = even(width * WATERMARK_MARGIN_FRACTION);
  const bottomMargin = even(width * WATERMARK_BOTTOM_MARGIN_FRACTION);
  const x = Math.max(0, Math.min(even(margin), evenFloor(width - w)));
  const y = Math.max(0, Math.min(even(height - h - bottomMargin), evenFloor(height - h)));
  return { w, h, x, y };
}

/**
 * The ffmpeg `-filter_complex` graph that stamps the corner watermark as the
 * capture is encoded. Input 0 is the live frame pipe, input 1 the white logo
 * PNG: the logo is scaled into the corner box, a near-black copy derived, and
 * maskedmerge picks between them per pixel from the background luma under the
 * box, for contrast against whatever is behind it.
 *
 * Input 1 is opened looped, so it is an endless stream and `shortest=1` on the
 * overlay is what ends the graph when the frame pipe closes. Every input runs
 * at OUTPUT_FPS so maskedmerge's per-frame streams stay in lockstep.
 */
export function buildWatermarkGraph(dims: Dimensions): string {
  // libx264 with yuv420p fails on an odd frame size, and some devices stream
  // one (1179x2556). Even the base up front and derive the box from the same
  // evened size so the mask crop stays inside it; an even frame is unchanged.
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
 * deleting one another's file.
 */
export async function writeLogoTemp(): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `argent-watermark-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  await fs.writeFile(file, Buffer.from(WATERMARK_PNG_BASE64, "base64"));
  return file;
}
