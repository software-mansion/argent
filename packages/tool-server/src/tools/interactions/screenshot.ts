import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { httpScreenshot } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. iOS: simulator UDID (UUID shape). Android: adb serial (e.g. `emulator-5554`)."
    ),
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

export const screenshotTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { url: string; path: string }
> = {
  id: "screenshot",
  description: `Capture a screenshot of the device screen on iOS or Android. Returns { url, path }; the MCP adapter renders it as a visible image.
Use when you need a baseline before an interaction or to inspect the current screen after a delay.
Both platforms route through simulator-server which serves the PNG over HTTP. Fails if the simulator server cannot start or the screenshot request times out.`,
  zodSchema,
  outputHint: "image",
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
    },
  }),
  async execute(services, params, options) {
    const api = services.simulatorServer as SimulatorServerApi;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal, params.scale);
  },
};
