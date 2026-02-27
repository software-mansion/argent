import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { httpScreenshot } from "../simulator-api";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  rotation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .optional()
    .describe("Orientation override for the screenshot"),
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
Requires a Pro JWT token — pass it via the token param or call simulator-server first.
If screenshot times out, the simulator-server likely has no token; restart with a token.`,
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
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal);
  },
};
