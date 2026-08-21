import { PNG } from "pngjs";
import { getScreenshotScale } from "./simulator-client";
import { resizeDecodedPng } from "../tools/screenshot-diff/resize";

/**
 * Downscale a decoded RGBA PNG by `scale`.
 *
 * Used by the platforms that capture a full-resolution PNG host-side and have
 * to shrink it themselves — Vega over the emulator console, HarmonyOS over
 * `uitest screenCap` — where iOS and Android get the same reduction from
 * simulator-server. Sharing one implementation is what keeps
 * `ARGENT_SCREENSHOT_SCALE` meaning the same thing on every platform: the
 * default and range handling come from `getScreenshotScale()` (which rejects
 * out-of-(0,1] values and falls back to 0.25), and the resample is the lanczos3
 * `resizeDecodedPng()` that screenshot-diff uses, so a HarmonyOS baseline and an
 * Android one are comparable at the same quality.
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
