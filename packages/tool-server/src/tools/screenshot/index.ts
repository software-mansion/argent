import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { httpScreenshot } from "../../utils/simulator-client";
import { captureVegaScreenshotPng } from "../../utils/vega-screen";
import { ensureDep } from "../../utils/check-deps";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  rotation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .optional()
    .describe("Orientation override for the screenshot"),
  scale: z
    .number()
    .min(0.01)
    .max(1.0)
    .optional()
    .describe(
      "Scale factor (0.01-1.0). Defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.3 if unset. Use 1.0 only when saving full-resolution PNG artifacts."
    ),
  includeImageInContext: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true. Set false only when capturing a full-resolution PNG (scale: 1.0) to save as a baseline/current for screenshot-diff — the file is still written, but the image bytes are not attached to the agent context."
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
  vega: { virtual: true },
};

export const screenshotTool: ToolDefinition<Params, Result> = {
  id: "screenshot",
  description: `Capture a screenshot of the device screen (iOS simulator, Android emulator, or Vega Virtual Device). Returns { url, path }; the MCP adapter renders it as a visible image unless the caller passed includeImageInContext: false.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator-server / emulator backend is not reachable for the given device. On Vega the screen is captured from the Virtual Device via the Android emulator console (host-side, requires adb); rotation is ignored (the TV framebuffer is fixed landscape).`,
  alwaysLoad: true,
  searchHint: "device simulator emulator vega fire tv screen image capture baseline",
  zodSchema,
  outputHint: "image",
  capability,
  // Vega captures host-side via QMP and needs no simulator-server; resolving the
  // (iOS/Android-only) blueprint for a Vega device would throw.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "vega"
      ? {}
      : { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params, ctx) {
    const device = resolveDevice(params.udid);
    if (device.platform === "vega") {
      // Primary capture is the Android emulator console via `adb emu` (the VVD
      // is emulator-derived); it falls back to QMP screendump internally.
      await ensureDep("adb");
      const path = await captureVegaScreenshotPng({ scale: params.scale });
      const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
      return { image };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const signal = ctx?.signal ?? AbortSignal.timeout(16_000);
    const { path } = await httpScreenshot(api, params.rotation, signal, params.scale);
    const image = await requireArtifacts(ctx).register(path, { mimeType: "image/png" });
    return { image };
  },
};
