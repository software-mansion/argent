import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { httpScreenshot } from "../../utils/simulator-client";

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
      "Scale factor (0.01-1.0). Defaults to ARGENT_SCREENSHOT_SCALE env var, or 0.5 if unset. Use 1.0 for full resolution."
    ),
});

export const screenshotTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { url: string; path: string }
> = {
  id: "screenshot",
  description: `Capture a screenshot of the simulator screen and return it as a visible image.
Use when capturing a baseline before interactions, verifying UI state after a delay, or when no interaction tool was just called (interaction tools return a screenshot automatically).

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); rotation — optional orientation override (Portrait, LandscapeLeft, LandscapeRight, PortraitUpsideDown); scale — optional scale factor 0.01–1.0 (default 0.5).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "scale": 0.5 }
Returns { url, path } where url is a data URI and path is the saved file. Fails if the simulator is not booted or the simulator-server cannot start.`,
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
