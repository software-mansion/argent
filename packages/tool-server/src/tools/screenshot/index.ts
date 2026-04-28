import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type ScreenshotResult, type ScreenshotServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
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
  android: { emulator: true, device: true, unknown: true },
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
  execute: dispatchByPlatform<ScreenshotServices, Params, ScreenshotResult>({
    toolId: "screenshot",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
