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
      "Scale factor (0.01-1.0). Defaults to RADON_SCREENSHOT_SCALE env var, or 0.5 if unset. Use 1.0 for full resolution."
    ),
  token: z
    .string()
    .optional()
    .describe(
      "JWT token — used only if simulator-server is not yet started. Screenshot requires a Pro token."
    ),
});

export const screenshotTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { url: string; path: string }
> = {
  id: "screenshot",
  description: `Take a screenshot of the simulator screen. Returns { url, path }.
The MCP adapter returns this as a visible image.
Requires a Pro license — if this fails with a license error, call activate-sso first.`,
  zodSchema,
  outputHint: "image",
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
      options: { token: params.token },
    },
  }),
  async execute(services, params, options) {
    const api = services.simulatorServer as SimulatorServerApi;
    // Always push the current token into the running binary so it is
    // up-to-date even if the binary was started before activation.
    if (params.token) {
      api.setToken(params.token);
    }
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal, params.scale);
  },
};
