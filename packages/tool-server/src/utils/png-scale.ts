import { PNG } from "pngjs";
import { getScreenshotScale } from "./simulator-client";
import { resizeDecodedPng } from "../tools/screenshot-diff/resize";

/**
 * Downscale a decoded RGBA PNG with `getScreenshotScale()` as the default and
 * screenshot-diff's lanczos3 resampler, for platforms that capture full-size
 * PNGs host-side (Vega, HarmonyOS).
 */
export function scaleDecodedPng(src: PNG, scale?: number): PNG {
  const s = scale ?? getScreenshotScale();
  if (s >= 1) return src;
  const outW = Math.max(1, Math.round(src.width * s));
  const outH = Math.max(1, Math.round(src.height * s));
  const resized = resizeDecodedPng(
    { width: src.width, height: src.height, data: src.data },
    outW,
    outH
  );
  const out = new PNG({ width: resized.width, height: resized.height });
  resized.data.copy(out.data);
  return out;
}
