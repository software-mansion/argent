import * as fs from "node:fs";
import * as path from "node:path";
import type { CDPClient } from "../utils/debugger/cdp-client";
import { mediaDir } from "./cdp-session";
import type { DownscalerType, MediaReady, Rotation, ScreenshotOpts } from "./types";

interface SharpModule {
  (input: Buffer): {
    rotate(angle: number): ReturnType<SharpModule>;
    resize(
      width: number,
      height: number,
      opts: { kernel?: string; fit?: string }
    ): ReturnType<SharpModule>;
    png(opts?: { compressionLevel?: number }): ReturnType<SharpModule>;
    toBuffer(): Promise<Buffer>;
  };
}

let sharpCache: SharpModule | null | undefined;
let sharpLoadWarningEmitted = false;

/**
 * Try to load `sharp` once per process. It is an optional dependency — we
 * fall back to writing the raw CDP screenshot bytes when it's missing, and
 * emit one warning so the user knows scale / rotation were ignored. Adding
 * sharp as a hard dep would bloat the tool-server install with a ~30 MB
 * native binary every consumer pays for whether they touch Chromium or not.
 */
function tryLoadSharp(): SharpModule | null {
  if (sharpCache !== undefined) return sharpCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("sharp") as SharpModule;
    sharpCache = mod;
    return mod;
  } catch {
    sharpCache = null;
    return null;
  }
}

function warnSharpMissingOnce(reason: string): void {
  if (sharpLoadWarningEmitted) return;
  sharpLoadWarningEmitted = true;
  process.stderr.write(
    `[chromium-screenshot] sharp is not installed — ${reason} ignored. ` +
      `Install it with \`npm install sharp\` in the tool-server's environment to enable image post-processing.\n`
  );
}

const DOWNSCALER_TO_KERNEL: Record<DownscalerType, string> = {
  lanczos3: "lanczos3",
  box: "mitchell", // sharp doesn't expose a true box kernel; mitchell is the closest fast alternative
  bilinear: "lanczos2",
  nearest: "nearest",
};

const ROTATION_DEGREES: Record<Rotation, number> = {
  Portrait: 0,
  PortraitUpsideDown: 180,
  LandscapeLeft: 270,
  LandscapeRight: 90,
};

interface CaptureContext {
  cdp: CDPClient;
  /** Used in the persisted filename for traceability. */
  deviceId: string;
}

/**
 * One-shot capture pipeline:
 *   Page.captureScreenshot (PNG)
 *   ↓
 *   if rotation || scale<1 then sharp transform
 *   ↓
 *   write to mediaDir / argent-screenshot-<deviceId>-<timestamp|id>.png
 *
 * Returns { url: file://…, path } matching sim-server's MediaReady shape.
 */
export async function captureScreenshot(
  ctx: CaptureContext,
  opts: ScreenshotOpts = {}
): Promise<MediaReady> {
  // Always use PNG from CDP — JPEG would lose precision on downscale and
  // disagrees with sim-server's screenshot output format (also PNG).
  const cdpResult = (await ctx.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  })) as { data?: string };
  if (!cdpResult.data) {
    throw new Error("Chromium CDP: Page.captureScreenshot returned no data.");
  }
  let bytes = Buffer.from(cdpResult.data, "base64");

  const rotation = opts.rotation && opts.rotation !== "Portrait" ? opts.rotation : null;
  const scale = opts.scale != null && opts.scale > 0 && opts.scale < 1 ? opts.scale : null;

  if (rotation || scale) {
    const sharp = tryLoadSharp();
    if (!sharp) {
      const features = [rotation && "rotation", scale && "scale"].filter(Boolean).join(" + ");
      warnSharpMissingOnce(features);
    } else {
      let pipeline = sharp(bytes);
      if (rotation) pipeline = pipeline.rotate(ROTATION_DEGREES[rotation]);
      if (scale) {
        // Need the source dimensions to compute the target size in pixels.
        // sharp exposes them through `.metadata()` but that's an extra round
        // trip; reading the PNG header is faster and avoids a sharp call.
        const dims = readPngSize(bytes);
        if (dims) {
          const targetW = Math.max(1, Math.round(dims.width * scale));
          const targetH = Math.max(1, Math.round(dims.height * scale));
          pipeline = pipeline.resize(targetW, targetH, {
            kernel: DOWNSCALER_TO_KERNEL[opts.downscaler ?? "lanczos3"],
            fit: "fill",
          });
        }
      }
      // The newer @types/node strictly types `Buffer<ArrayBuffer>` while
      // sharp's d.ts still resolves to `Buffer<ArrayBufferLike>`. Both refer to
      // the same runtime object; coerce to silence the mismatch.
      bytes = Buffer.from(await pipeline.png({ compressionLevel: 6 }).toBuffer());
    }
  }

  const stem = opts.id ?? `${Date.now()}-${process.pid}`;
  const safeDeviceId = ctx.deviceId.replace(/[^A-Za-z0-9_-]/g, "_");
  const filePath = path.join(mediaDir(), `argent-screenshot-${safeDeviceId}-${stem}.png`);
  fs.writeFileSync(filePath, bytes);
  return { url: `file://${filePath}`, path: filePath };
}

/**
 * Read width / height from a PNG IHDR chunk without spinning up a decoder.
 * Returns null on a malformed or non-PNG buffer — the caller falls back to
 * sharp metadata in that case (which costs a roundtrip but always works).
 */
function readPngSize(buf: Buffer): { width: number; height: number } | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24) return null;
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) return null;
  }
  // IHDR chunk: length (4) + "IHDR" (4) + width (4) + height (4) + ...
  // Starts at offset 8, header data is at offset 16.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Sim-server can also copy a screenshot directly to the OS clipboard (handy
 * for "share this state with QA"). On Chromium we go through the renderer's
 * Clipboard API because CDP doesn't expose the OS clipboard. The path is
 * best-effort — if clipboard permission is denied the call rejects with the
 * underlying renderer error so callers can surface it.
 */
export async function copyScreenshotToClipboard(
  ctx: CaptureContext,
  opts: { rotation?: Rotation } = {}
): Promise<void> {
  const shot = await captureScreenshot(ctx, { rotation: opts.rotation });
  const bytes = fs.readFileSync(shot.path);
  const b64 = bytes.toString("base64");

  // Build a script that copies a PNG blob through the clipboard API. The
  // renderer must support ClipboardItem (Chromium ≥ 79, every Chromium we
  // care about) — older runtimes would throw, but the surrounding try/catch
  // surfaces that as a clear error rather than a silent no-op.
  const script = `(async () => {
    const b64 = "${b64}";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    if (!window.ClipboardItem) {
      return { ok: false, error: "ClipboardItem API unavailable in this renderer" };
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  })()`;
  const out = (await ctx.cdp.send(
    "Runtime.evaluate",
    { expression: script, awaitPromise: true, returnByValue: true },
    10_000
  )) as { result?: { value?: { ok?: boolean; error?: string } } };
  const v = out.result?.value;
  if (!v?.ok) {
    throw new Error(
      `Chromium clipboard image copy failed: ${v?.error ?? "renderer rejected the write"}`
    );
  }
}

/** Test seam: reset the cached sharp module so a unit test can simulate the
 * "sharp unavailable" path without monkey-patching require. */
export function __resetSharpCacheForTests(): void {
  sharpCache = undefined;
  sharpLoadWarningEmitted = false;
}
