import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { getScreenshotScale, httpScreenshot } from "../../utils/simulator-client";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  rotation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .optional()
    .describe(
      "Orientation override for the screenshot (rotates the captured image after Page.captureScreenshot on Chromium)."
    ),
  scale: z
    .number()
    .min(0.01)
    .max(1.0)
    .optional()
    .describe(
      "Scale factor (0.01-1.0). Defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.3 if unset for iOS/Android. " +
        "On Chromium the default is 1.0 (no downscale); pass <1 to opt in. Downscaling on Chromium requires the optional `sharp` dependency."
    ),
  includeImageInContext: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true. Set false only when capturing a full-resolution PNG (scale: 1.0) to save as a baseline/current for screenshot-diff — the file is still written, but the image bytes are not attached to the agent context."
    ),
  downscaler: z
    .enum(["lanczos3", "box", "bilinear", "nearest"])
    .optional()
    .describe(
      "Downscaling algorithm when scale<1 on Chromium. Defaults to lanczos3 (highest quality). Mirrors sim-server's wire enum."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  /**
   * The captured PNG as an artifact handle. The MCP client materializes it to
   * a local file and renders it inline — no second fetch of the simulator
   * server's `127.0.0.1` media URL, which is unreachable when the tool-server
   * is remote.
   */
  image: ArtifactHandle;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

/**
 * tvOS screenshot path. The simulator-server backend does not support tvOS, so
 * capture via `xcrun simctl io <udid> screenshot` instead and (optionally)
 * downscale with `sips` to match the iOS/Android scale behaviour.
 */
async function tvScreenshot(
  udid: string,
  scale: number,
  signal: AbortSignal | undefined
): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `argent-tv-screenshot-${udid.slice(0, 8)}-${process.hrtime.bigint()}.png`
  );
  await execFileAsync("xcrun", ["simctl", "io", udid, "screenshot", file], { signal });
  // tvOS captures are 4K (3840x2160). Downscale in place unless full-res was
  // explicitly requested, mirroring the default 0.3 scale the iOS/Android path
  // applies server-side.
  if (scale < 1.0) {
    await execFileAsync("sips", ["-Z", String(Math.round(3840 * scale)), file], { signal }).catch(
      () => {
        // Best-effort downscale: if sips is unavailable or fails, fall back to
        // the full-resolution capture rather than failing the screenshot.
      }
    );
  }
  return file;
}

export function createScreenshotTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "screenshot",
    description: `Capture a screenshot of the device screen (iOS simulator, Android emulator, Apple TV simulator, or Chromium app). Returns { url, path }; the MCP adapter renders it as a visible image unless the caller passed includeImageInContext: false.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device.`,
    alwaysLoad: true,
    searchHint: "device simulator emulator chromium screen image capture baseline tvos apple tv",
    zodSchema,
    outputHint: "image",
    capability,
    // No eager service: a tvOS udid classifies as iOS by shape, and declaring
    // simulator-server here would spawn it for the tvOS device (which it cannot
    // drive) and hang on the ready timeout. Resolve the backend lazily instead.
    services: () => ({}),
    async execute(_services, params, ctx) {
      const signal = ctx?.signal ?? AbortSignal.timeout(16_000);
      const scale = params.scale ?? getScreenshotScale();
      const device = resolveDevice(params.udid);

      // Chromium captures via CDP (Page.captureScreenshot) — no simulator-server.
      if (device.platform === "chromium") {
        const ref = chromiumCdpRef(device);
        const chromium = (await registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
        const { path: capturedPath } = await chromium.captureScreenshot({
          rotation: params.rotation,
          scale: params.scale,
          downscaler: params.downscaler,
        });
        const image = await requireArtifacts(ctx).register(capturedPath, { mimeType: "image/png" });
        return { image };
      }

      // Distinguish tvOS from iOS by simulator runtime — shape alone can't.
      // tvOS has no simulator-server backend, so capture via xcrun instead.
      if (device.platform === "ios" && (await isTvOsSimulator(params.udid))) {
        const pngPath = await tvScreenshot(params.udid, scale, signal);
        const image = await requireArtifacts(ctx).register(pngPath, { mimeType: "image/png" });
        return { image };
      }

      const ref = simulatorServerRef(device);
      const api = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
      const { path: capturedPath } = await httpScreenshot(
        api,
        params.rotation,
        signal,
        params.scale
      );
      const image = await requireArtifacts(ctx).register(capturedPath, { mimeType: "image/png" });
      return { image };
    },
  };
}
