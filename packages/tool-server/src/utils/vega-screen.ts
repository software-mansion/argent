import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { runAdb } from "./adb";
import { discoverVegaConsolePort } from "./vega-vvd";
import { getScreenshotScale } from "./simulator-client";
import { resizeDecodedPng } from "../tools/screenshot-diff/resize";

/**
 * Capture the VVD screen as a PNG.
 *
 * The VVD is an Android-emulator-derived QEMU, so its emulator console captures
 * the composited display (GL surface included) host-side. We go through
 * `adb emu` because it manages the console auth token that the VVD never
 * generates but a direct console socket would require.
 */
export async function captureVegaScreenshotPng(opts: { scale?: number } = {}): Promise<string> {
  return captureViaEmulatorConsole(opts);
}

async function captureViaEmulatorConsole(opts: { scale?: number }): Promise<string> {
  const port = await discoverVegaConsolePort();
  const serial = `emulator-${port}`;
  const outDir = await mkdtemp(join(tmpdir(), "vega-shot-"));
  try {
    // `screenrecord screenshot <dir>` writes the PNG host-side into the
    // directory under a name it picks.
    await runAdb(["-s", serial, "emu", "screenrecord", "screenshot", outDir], {
      timeoutMs: 20_000,
    });
    const pngName = (await readdir(outDir)).find((f) => f.toLowerCase().endsWith(".png"));
    if (!pngName) {
      throw new FailureError(`emulator console wrote no PNG to ${outDir} for ${serial}`, {
        error_code: FAILURE_CODES.VEGA_SCREENSHOT_FAILED,
        failure_stage: "vega_screenshot_no_png",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }
    const decoded = PNG.sync.read(await readFile(join(outDir, pngName)));
    const scaled = scalePng(decoded, opts.scale);
    const outPath = join(tmpdir(), `vega-screenshot-${process.hrtime.bigint()}.png`);
    await writeFile(outPath, PNG.sync.write(scaled));
    return outPath;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Downscale a decoded RGBA PNG, reusing the other platforms' default
 * (`getScreenshotScale()`, which parses `ARGENT_SCREENSHOT_SCALE`) and
 * screenshot-diff's lanczos3 resampler, so Vega captures match them.
 */
function scalePng(src: PNG, scale?: number): PNG {
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
