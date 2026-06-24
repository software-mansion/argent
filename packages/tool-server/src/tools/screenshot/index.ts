import { z } from "zod";
import type {
  InvokeToolOptions,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { coreDeviceRef, type CoreDeviceApi } from "../../blueprints/core-device";
import { resolveDevice, isPhysicalIos } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { httpScreenshot } from "../../utils/simulator-client";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

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
  vega: { vvd: true },
};

interface SimulatorServerServices {
  simulatorServer: SimulatorServerApi;
}

// iOS resolves to one of two services by device kind: the simulator-server for a
// simulator, or CoreDevice (pymobiledevice3) for a physical iPhone/iPad. Only one
// is ever present per device, so both are optional and the ios handler picks by kind.
interface IosServices {
  simulatorServer?: SimulatorServerApi;
  coreDevice?: CoreDeviceApi;
}

interface ChromiumServices {
  chromium: ChromiumCdpApi;
}

async function runChromium(
  api: ChromiumCdpApi,
  params: Params,
  ctx?: InvokeToolOptions
): Promise<Result> {
  const { path } = await api.captureScreenshot({
    rotation: params.rotation,
    scale: params.scale,
    downscaler: params.downscaler,
  });
  const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
  return { image };
}

// Shared iOS / Android path: both capture over the bundled simulator-server's
// HTTP screenshot endpoint. The blueprint factory backing
// `services.simulatorServer` already preflights the platform binary, so these
// branches declare no `requires`.
async function runSimulatorServer(
  api: SimulatorServerApi,
  params: Params,
  ctx?: InvokeToolOptions
): Promise<Result> {
  const signal = ctx?.signal ?? AbortSignal.timeout(16_000);
  const { path } = await httpScreenshot(api, params.rotation, signal, params.scale);
  const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
  return { image };
}

// Vega captures host-side via the Android emulator console (`adb emu`) and needs
// no simulator-server. The `adb` dependency is declared on the vega dispatch
// branch's `requires` and preflighted by dispatchByPlatform before this runs.
async function runVega(params: Params, ctx?: InvokeToolOptions): Promise<Result> {
  const path = await captureVegaScreenshotPng({ scale: params.scale });
  const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
  return { image };
}

// A physical iOS device captures over CoreDevice (pymobiledevice3), not the
// simulator-server. CoreDevice returns a full-resolution PNG; rotation/scale/
// downscaler are simulator/Chromium-only knobs and don't apply to the device.
async function runCoreDevice(
  api: CoreDeviceApi,
  _params: Params,
  ctx?: InvokeToolOptions
): Promise<Result> {
  const { path } = await api.screenshot();
  const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
  return { image };
}

export const screenshotTool: ToolDefinition<Params, Result> = {
  id: "screenshot",
  description: `Capture a screenshot of the device screen (iOS simulator, Android emulator, Chromium app, or Vega Virtual Device). Returns { url, path }; the MCP adapter renders it as a visible image unless the caller passed includeImageInContext: false.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator-server / emulator backend / Chromium CDP is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "device simulator emulator chromium vega fire tv screen image capture baseline",
  zodSchema,
  outputHint: "image",
  capability,
  // Vega captures host-side via the Android emulator console (`adb emu`) and
  // needs no simulator-server; resolving the (iOS/Android-only) blueprint for a
  // Vega device would throw.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    if (isPhysicalIos(device)) {
      return { coreDevice: coreDeviceRef(device) };
    }
    if (device.platform === "vega") {
      return {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  execute: dispatchByPlatform<
    IosServices,
    SimulatorServerServices,
    Params,
    Result,
    ChromiumServices,
    Record<string, unknown>
  >({
    toolId: "screenshot",
    capability,
    ios: {
      // A physical iPhone/iPad captures over CoreDevice; a simulator over the
      // simulator-server. Both resolve to platform "ios"; pick by device kind.
      handler: (services, params, device, options) =>
        isPhysicalIos(device)
          ? runCoreDevice(services.coreDevice!, params, options)
          : runSimulatorServer(services.simulatorServer!, params, options),
    },
    android: {
      handler: (services, params, _device, options) =>
        runSimulatorServer(services.simulatorServer, params, options),
    },
    chromium: {
      handler: (services, params, _device, options) =>
        runChromium(services.chromium, params, options),
    },
    vega: {
      requires: ["adb"],
      handler: (_services, params, _device, options) => runVega(params, options),
    },
  }),
};
