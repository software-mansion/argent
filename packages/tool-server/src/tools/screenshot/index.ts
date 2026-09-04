import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  FAILURE_CODES,
  type Registry,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { isIosPhysicalDevice, resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import { getScreenshotScale } from "../../utils/simulator-client";
import { captureScreenshotUpright } from "../../utils/rotation-aware-capture";
import { androidDevtoolsRotationPeek } from "../../utils/android-devtools-rotation-peek";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { captureRunnerScreenshotPng } from "../../utils/ios-device/runner-commands";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../../utils/ios-device/runner-client";
import { simctlArgsForUdid } from "../../utils/ios-device-sets";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { captureHarmonyScreenshotPng } from "../../utils/harmony-screen";
import { ensureDep } from "../../utils/check-deps";
import { InvalidToolInputError } from "../../utils/capability";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import type { DeviceInfo } from "@argent/registry";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Apple TV UDID, Vega serial, HarmonyOS id, or Chromium id)."
    ),
  rotation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .optional()
    .describe(
      "Orientation override for the screenshot (rotates the captured image after Page.captureScreenshot on Chromium). On Android the capture already follows the device's rotation. Rejected on HarmonyOS, which captures the display in its current orientation and has no override. Ignored on physical iPhones."
    ),
  scale: z
    .number()
    .min(0.01)
    .max(1.0)
    .optional()
    .describe(
      "Scale factor (0.01-1.0). Defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.25 if unset for iOS/Android/HarmonyOS/Vega. " +
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
      "Downscaling algorithm when scale<1 on Chromium. Defaults to lanczos3 (highest quality). Mirrors sim-server's wire enum. Ignored on physical iPhones."
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
  harmony: { device: true },
};

/**
 * Capture a physical-iOS screenshot through the on-device XCUITest runner.
 */
async function iosPhysicalScreenshot(
  registry: Registry,
  device: DeviceInfo,
  scale: number
): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `argent-ios-device-screenshot-${device.id.slice(0, 8)}-${process.hrtime.bigint()}.png`
  );

  const ref = iosDeviceRunnerRef(device);
  const runner = (await registry.resolveService(ref.urn, ref.options)) as IosDeviceRunnerApi;

  // Client timeout must exceed the runner screenshot budget. A shorter window turns COMMAND_TIMED_OUT into a transport timeout.
  await fs.writeFile(file, await captureRunnerScreenshotPng(runner, RUNNER_COMMAND_TIMEOUT_MS));
  await downscalePngInPlace(file, scale);

  return file;
}

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

/**
 * Best-effort in-place downscale via sips. Keeps the original file if sips fails.
 */
export async function downscalePngInPlace(
  file: string,
  scale: number,
  signal?: AbortSignal
): Promise<void> {
  if (scale >= 1.0) {
    return;
  }

  await execFileAsync("sips", ["-Z", String(await tvTargetLongSide(file, scale)), file], {
    signal,
  }).catch(() => {
    // Best-effort: keep the full-resolution capture if sips fails.
  });
}

export function createScreenshotTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "screenshot",
    interaction: {
      startedMsg: () => "Capturing screenshot",
      completedMsg: ({ result }) => `Captured screenshot ${result.image.filename}`,
      failedMsg: ({ failureSignal }) => `Failed to capture screenshot: ${failureSignal.error_code}`,
    },
    description: `Capture a screenshot of the device screen (iOS simulator or physical device, Android emulator, Apple TV simulator, Vega, HarmonyOS device, or Chromium app). Returns { image }; the MCP adapter renders it as a visible image unless the caller passed includeImageInContext: false.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator-server / emulator backend / Chromium CDP / \`hdc\` is not reachable for the given device.`,
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

      // Physical devices use the runner. Probe tvOS only after this. simctl does not list hardware UDIDs.
      if (isIosPhysicalDevice(device)) {
        const pngPath = await iosPhysicalScreenshot(registry, device, scale);
        const image = await requireArtifacts(ctx).register({
          hostPath: pngPath,
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

      // HarmonyOS captures on-device with `uitest screenCap` and copies the PNG
      // back over hdc; there is no simulator-server controller for the platform.
      if (device.platform === "harmony") {
        if (params.rotation) {
          // A per-ARGUMENT refusal, not a per-tool one: screenshot works on
          // every harmony device — only this parameter has no effect. Same
          // class the keyboard backend uses for an unsupported key.
          throw new InvalidToolInputError(
            "rotation is not supported on HarmonyOS: `uitest screenCap` captures the display in its current orientation and has no override. Rotate the device itself, or drop the rotation parameter.",
            {
              error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
              failure_stage: "harmony_screenshot_rotation",
            }
          );
        }
        await ensureDep("hdc");
        const pngPath = await captureHarmonyScreenshotPng({
          connectKey: harmonyConnectKey(device.id),
          scale: params.scale,
        });
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
