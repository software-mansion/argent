import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runAdb } from "./adb";
import { discoverVegaConsolePort, captureVegaScreenshotViaQmp } from "./vega-qmp";

/**
 * Capture the VVD screen as a PNG.
 *
 * The Vega Virtual Device is an Android-emulator-derived QEMU, so the emulator
 * console can capture the *composited* display host-side (including the GL
 * surface) via `screenrecord screenshot` — exactly the frame QMP `screendump`
 * cannot read on macOS. We reach the console through `adb emu`, which manages
 * the emulator console auth token (`~/.emulator_console_auth_token`)
 * automatically; talking to the console socket directly would require that
 * token, which the VVD does not generate.
 *
 * Primary: emulator console (`adb -s emulator-<port> emu screenrecord
 * screenshot`). Fallback: QMP `screendump` (works on a Linux `--no-gl-accel`
 * VVD where the framebuffer lives in the QEMU console).
 */
export async function captureVegaScreenshotPng(opts: { scale?: number } = {}): Promise<string> {
  try {
    return await captureViaEmulatorConsole(opts);
  } catch (emuErr) {
    try {
      return await captureVegaScreenshotViaQmp(opts);
    } catch (qmpErr) {
      const e1 = emuErr instanceof Error ? emuErr.message : String(emuErr);
      const e2 = qmpErr instanceof Error ? qmpErr.message : String(qmpErr);
      throw new Error(
        `Vega screen capture failed. Emulator-console path: ${e1} | QMP fallback: ${e2}`
      );
    }
  }
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
      throw new Error(`emulator console wrote no PNG to ${outDir} for ${serial}`);
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

/** Nearest-neighbour downscale of a decoded RGBA PNG by `scale` (default 0.3). */
function scalePng(src: PNG, scale = Number(process.env.ARGENT_SCREENSHOT_SCALE) || 0.3): PNG {
  const s = Math.min(Math.max(scale, 0.01), 1.0);
  if (s >= 1) return src;
  const outW = Math.max(1, Math.round(src.width * s));
  const outH = Math.max(1, Math.round(src.height * s));
  const out = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(src.height - 1, Math.floor(y / s));
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(src.width - 1, Math.floor(x / s));
      const si = (srcY * src.width + srcX) * 4;
      const di = (y * outW + x) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = src.data[si + 3]!;
    }
  }
  return out;
}
