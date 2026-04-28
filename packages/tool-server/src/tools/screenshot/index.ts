import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { screenshotIos, type ScreenshotResult, type ScreenshotServices } from "./platforms/ios";
import { screenshotAndroid } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
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
      "Scale factor (0.01-1.0). Defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.3 if unset. Use 1.0 for full resolution."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const screenshotTool: ToolDefinition<Params, ScreenshotResult> = {
  id: "screenshot",
  description: `Capture a screenshot of the simulator screen. Returns { url, path } and the MCP adapter renders it as a visible image.
Use when you need a baseline image before an interaction or to inspect the current screen state after a delay.
Fails if the simulator server is not running or the screenshot request times out.`,
  alwaysLoad: true,
  searchHint: "simulator screen image capture baseline",
  zodSchema,
  outputHint: "image",
  capability,
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
    },
  }),
  async execute(services, params, options) {
    const device = resolveDevice(params.udid);
    assertSupported("screenshot", capability, device);
    const platformServices = services as unknown as ScreenshotServices;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return device.platform === "ios"
      ? screenshotIos(platformServices, params, signal)
      : screenshotAndroid(platformServices, params, signal);
  },
};
