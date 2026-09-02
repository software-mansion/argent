import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { getScreenshotScale } from "../../utils/simulator-client";
import { captureScreenshotUpright } from "../../utils/rotation-aware-capture";
import { androidDevtoolsRotationPeek } from "../../utils/android-devtools-rotation-peek";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { simctlArgsForUdid } from "../../utils/ios-device-sets";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Apple TV UDID, Vega serial, or Chromium id)."
    ),
  rotation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .optional()
    .describe(
      "Orientation override for the screenshot. Applied on Android and on local iOS simulators, and on Chromium after Page.captureScreenshot — where, like downscaling, it needs the optional `sharp` dependency. Apple TV, Vega and remote iOS simulators accept it and capture unrotated. With no rotation passed, Android captures upright already — it follows the device's own rotation."
    ),
  scale: z
    .number()
    .min(0.01)
    .max(1.0)
    .optional()
    .describe(
      "Scale factor (0.01-1.0). On iOS, Android, Apple TV and Vega, defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.25 whenever that is unset or outside (0,1]. " +
        "On Chromium the default is 1.0 (no downscale); pass <1 to opt in. Downscaling on Chromium requires the optional `sharp` dependency. " +
        "Some Android emulators cannot stream a full-resolution frame and reject scale: 1.0 with a `wrong data size` error; omit `scale` there, which is where screenshot-diff's own live capture lands once its 1.0 attempt fails, so a baseline saved that way matches it — unless ARGENT_SCREENSHOT_SCALE is itself 1.0, where omitting it repeats the rejected request and both sides have to be saved at the same explicit scale instead."
    ),
  includeImageInContext: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true. Set false only when capturing a baseline/current PNG for screenshot-diff — the file is still written, but the image bytes are not attached to the agent context."
    ),
  downscaler: z
    .enum(["lanczos3", "box", "bilinear", "nearest"])
    .optional()
    .describe(
      "Downscaling algorithm when scale<1 on Chromium, where it goes through the same optional `sharp` dependency the downscale itself needs. Defaults to lanczos3 (highest quality). Mirrors sim-server's wire enum."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  /**
   * Captured PNG as an artifact handle: the MCP client materializes it locally
   * rather than fetching the simulator server's `127.0.0.1` media URL, which is
   * unreachable when the tool-server is remote.
   */
  image: ArtifactHandle;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

/**
 * tvOS screenshot path: simulator-server has no tvOS backend, so capture with
 * `xcrun simctl io <udid> screenshot` and downscale via `sips` to match the
 * iOS/Android scale behaviour.
 *
 * Exported for the flow settle, which captures for motion detection rather than
 * for an artifact and so cannot go through the tool.
 */
export async function tvScreenshot(
  udid: string,
  scale: number,
  signal: AbortSignal | undefined
): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `argent-tv-screenshot-${udid.slice(0, 8)}-${process.hrtime.bigint()}.png`
  );
  await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["io", udid, "screenshot", file]), {
    signal,
  });
  // `sips -Z` caps the longest *actual* side, and capture size isn't fixed (4K
  // sim is 3840 wide, non-4K is 1920), so scale against the real dimensions — a
  // hardcoded 3840 would double the scale on a 1920 capture.
  if (scale < 1.0) {
    await execFileAsync("sips", ["-Z", String(await tvTargetLongSide(file, scale)), file], {
      signal,
    }).catch(() => {
      // Best-effort: keep the full-resolution capture if sips fails.
    });
  }
  return file;
}

// Longest actual side × scale, falling back to the 4K long side if the
// dimension probe fails.
export async function tvTargetLongSide(file: string, scale: number): Promise<number> {
  let longSide = 3840;
  try {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      longSide = Math.max(width, height);
    }
  } catch {
    /* probe failed — keep the 4K fallback */
  }
  return Math.round(longSide * scale);
}

export function createScreenshotTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "screenshot",
    interaction: {
      startedMsg: () => "Capturing screenshot",
      completedMsg: ({ result }) => `Captured screenshot ${result.image.filename}`,
      failedMsg: ({ failureSignal }) => `Failed to capture screenshot: ${failureSignal.error_code}`,
    },
    description: `Capture a screenshot of the device screen (iOS simulator, Android emulator, Apple TV simulator, Vega, or Chromium app). Returns { image }; the MCP adapter renders it as a visible image unless the caller passed includeImageInContext: false.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device, or if the device rejects a capture at the requested scale.`,
    alwaysLoad: true,
    searchHint: "device simulator emulator chromium screen image capture baseline tvos apple tv",
    zodSchema,
    outputHint: "image",
    capability,
    // No eager service: a tvOS udid classifies as iOS by shape, so declaring
    // simulator-server here would spawn it for a device it cannot drive and hang
    // on the ready timeout. Resolve the backend lazily instead.
    services: () => ({}),
    async execute(_services, params, ctx) {
      const signal = ctx?.signal ?? AbortSignal.timeout(16_000);
      const scale = params.scale ?? getScreenshotScale();
      const device = resolveDevice(params.udid);

      // Chromium captures via CDP — no simulator-server.
      if (device.platform === "chromium") {
        const ref = chromiumCdpRef(device);
        const chromium = (await registry.resolveService(ref.urn, ref.options)) as ChromiumCdpApi;
        const { path: capturedPath } = await chromium.captureScreenshot({
          rotation: params.rotation,
          scale: params.scale,
          downscaler: params.downscaler,
        });
        const image = await requireArtifacts(ctx).register({
          hostPath: capturedPath,
          kind: "screenshot",
          mimeType: "image/png",
        });
        return { image };
      }

      // Shape alone can't tell tvOS from iOS, and tvOS has no simulator-server
      // backend.
      if (device.platform === "ios" && (await isTvOsSimulator(params.udid))) {
        const pngPath = await tvScreenshot(params.udid, scale, signal);
        const image = await requireArtifacts(ctx).register({
          hostPath: pngPath,
          kind: "screenshot",
          mimeType: "image/png",
        });
        return { image };
      }

      // Vega captures host-side via the Android emulator console (`adb emu`);
      // resolving the iOS/Android-only simulator-server blueprint would throw.
      if (device.platform === "vega") {
        const pngPath = await captureVegaScreenshotPng({ scale: params.scale });
        const image = await requireArtifacts(ctx).register({
          hostPath: pngPath,
          kind: "screenshot",
          mimeType: "image/png",
        });
        return { image };
      }

      const ref = simulatorServerRef(device);
      const api = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
      const { path: capturedPath } = await captureScreenshotUpright(
        api,
        device,
        params.rotation,
        signal,
        params.scale,
        undefined,
        androidDevtoolsRotationPeek(registry, device)
      );
      const image = await requireArtifacts(ctx).register({
        hostPath: capturedPath,
        kind: "screenshot",
        mimeType: "image/png",
      });
      return { image };
    },
  };
}
