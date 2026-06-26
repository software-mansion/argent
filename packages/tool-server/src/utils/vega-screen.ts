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
 * The Vega Virtual Device is an Android-emulator-derived QEMU, so the emulator
 * console can capture the *composited* display host-side (including the GL
 * surface) via `screenrecord screenshot`. We reach the console through
 * `adb emu`, which manages the emulator console auth token
 * (`~/.emulator_console_auth_token`) automatically; talking to the console
 * socket directly would require that token, which the VVD does not generate.
 *
 * This is the only capture path: QMP `screendump` cannot read the GL-accelerated
 * surface on macOS (it returns a blank frame) and the on-device
 * `gwsi-tool-screenshooter` segfaults on the VVD, so neither is a usable
 * fallback. `captureViaEmulatorConsole` throws an actionable error if `adb emu`
 * itself fails.
 */
export async function captureVegaScreenshotPng(opts: { scale?: number } = {}): Promise<string> {
  return captureViaEmulatorConsole(opts);
}

async function captureViaEmulatorConsole(opts: { scale?: number }): Promise<string> {
  const port = await discoverVegaConsolePort();
  const serial = `emulator-${port}`;
  const outDir = await mkdtemp(join(tmpdir(), "vega-shot-"));
  try {
    // `screenrecord screenshot <dir>` writes a host-side PNG named
    // `Screenshot_<epoch>.png` into the directory and prints "OK".
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
 * Downscale a decoded RGBA PNG by `scale`. Defaults and resampling are shared
 * with the other platforms rather than re-derived here: the default + range
 * handling comes from `getScreenshotScale()` (the iOS/Android env parser, which
 * rejects out-of-(0,1] values and falls back to 0.3), and the resample is the
 * lanczos3 `resizeDecodedPng()` used by screenshot-diff — so Vega screenshots
 * honour `ARGENT_SCREENSHOT_SCALE` identically and at the same quality.
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
