import * as fs from "node:fs";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
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
 * Cached once per process. `sharp` is optional and declared as a dependency
 * nowhere in this repo; without it scale / rotation are skipped.
 */
function tryLoadSharp(): SharpModule | null {
  if (sharpCache !== undefined) return sharpCache;
  try {
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
  box: "mitchell", // sharp has no box kernel
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
  /** Used in the persisted filename. */
  deviceId: string;
}

/** Capture, optionally rotate / downscale with sharp, persist under `mediaDir()`. */
export async function captureScreenshot(
  ctx: CaptureContext,
  opts: ScreenshotOpts = {}
): Promise<MediaReady> {
  // PNG, not JPEG: matches sim-server's output and survives the downscale.
  const cdpResult = (await ctx.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  })) as { data?: string };
  if (!cdpResult.data) {
    throw new FailureError("Chromium CDP: Page.captureScreenshot returned no data.", {
      error_code: FAILURE_CODES.CHROMIUM_SCREENSHOT_FAILED,
      failure_stage: "chromium_screenshot_capture",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  }
  let bytes = Buffer.from(cdpResult.data, "base64");

  const rotation = opts.rotation && opts.rotation !== "Portrait" ? opts.rotation : null;
  const scale = opts.scale != null && opts.scale > 0 && opts.scale < 1 ? opts.scale : null;

  const dropped: ("rotation" | "scale")[] = [];
  let dropReason: MediaReady["dropReason"];

  if (rotation || scale) {
    const sharp = tryLoadSharp();
    if (!sharp) {
      const features = [rotation && "rotation", scale && "scale"].filter(Boolean).join(" + ");
      warnSharpMissingOnce(features);
      if (rotation) dropped.push("rotation");
      if (scale) dropped.push("scale");
      dropReason = "sharp-missing";
    } else {
      let pipeline = sharp(bytes);
      if (rotation) pipeline = pipeline.rotate(ROTATION_DEGREES[rotation]);
      if (scale) {
        // Cheaper than asking sharp for `.metadata()`.
        const dims = readPngSize(bytes);
        if (dims) {
          // sharp runs the rotation ahead of the resize regardless of call
          // order, so a quarter turn means the resize sees swapped dimensions.
          // Sizing the target from the unrotated header with `fit: "fill"`
          // would squash the rotated image into the wrong aspect ratio.
          const quarterTurn = rotation === "LandscapeLeft" || rotation === "LandscapeRight";
          const rotatedW = quarterTurn ? dims.height : dims.width;
          const rotatedH = quarterTurn ? dims.width : dims.height;
          const targetW = Math.max(1, Math.round(rotatedW * scale));
          const targetH = Math.max(1, Math.round(rotatedH * scale));
          pipeline = pipeline.resize(targetW, targetH, {
            kernel: DOWNSCALER_TO_KERNEL[opts.downscaler ?? "lanczos3"],
            fit: "fill",
          });
        } else {
          // Header unreadable: the rotation still runs, but the resize cannot
          // be sized, so the scale the caller asked for is lost.
          dropped.push("scale");
          dropReason = "png-header-unreadable";
        }
      }
      bytes = Buffer.from(await pipeline.png({ compressionLevel: 6 }).toBuffer());
    }
  }

  const stem = opts.id ?? `${Date.now()}-${process.pid}`;
  const safeDeviceId = ctx.deviceId.replace(/[^A-Za-z0-9_-]/g, "_");
  const filePath = path.join(mediaDir(), `argent-screenshot-${safeDeviceId}-${stem}.png`);
  fs.writeFileSync(filePath, bytes);
  return {
    url: `file://${filePath}`,
    path: filePath,
    ...(dropped.length > 0 ? { droppedFeatures: dropped, dropReason } : {}),
  };
}

/**
 * Read width / height from a PNG IHDR chunk without spinning up a decoder.
 * Returns null on a malformed or non-PNG buffer. The caller skips the resize in
 * that case and reports `scale` as dropped — there is no metadata fallback.
 */
function readPngSize(buf: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24) return null;
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) return null;
  }
  // IHDR starts at offset 8: length (4) + "IHDR" (4), then width, height.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Goes through the renderer's Clipboard API because CDP exposes no OS clipboard.
 * Rejects with the renderer's own error when the write is refused.
 */
export async function copyScreenshotToClipboard(
  ctx: CaptureContext,
  opts: { rotation?: Rotation } = {}
): Promise<void> {
  const shot = await captureScreenshot(ctx, { rotation: opts.rotation });
  const bytes = fs.readFileSync(shot.path);
  const b64 = bytes.toString("base64");

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
    // Plain Error, not FailureError: no production caller, and the sibling
    // clipboard route reformats errors before any registry boundary.
    throw new Error(
      `Chromium clipboard image copy failed: ${v?.error ?? "renderer rejected the write"}`
    );
  }
}

/** Test seam: clears the cached sharp module and the one-shot warning flag. */
export function __resetSharpCacheForTests(): void {
  sharpCache = undefined;
  sharpLoadWarningEmitted = false;
}
