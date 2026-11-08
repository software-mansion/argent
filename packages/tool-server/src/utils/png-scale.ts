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

/**
 * Average each `factor`×`factor` square of pixels into one, for a whole-number
 * ratio. Page text reads as well as after lanczos, at a fraction of the CPU
 * and a much smaller PNG.
 */
export function boxDownscaleDecodedPng(src: PNG, factor: number): PNG {
  const width = Math.floor(src.width / factor);
  const height = Math.floor(src.height / factor);
  const out = new PNG({ width, height });
  const samples = factor * factor;
  const half = samples >> 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let row = 0; row < factor; row++) {
        let i = ((y * factor + row) * src.width + x * factor) * 4;
        for (let col = 0; col < factor; col++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
        }
      }
      out.data[o++] = ((r + half) / samples) | 0;
      out.data[o++] = ((g + half) / samples) | 0;
      out.data[o++] = ((b + half) / samples) | 0;
      out.data[o++] = ((a + half) / samples) | 0;
    }
  }
  return out;
}
