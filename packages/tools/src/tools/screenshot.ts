import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, httpScreenshot } from "../simulator-registry";

const inputSchema = z.object({
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

export const screenshotTool: Tool<
  typeof inputSchema,
  { url: string; path: string }
> = {
  name: "screenshot",
  description: `Take a screenshot of the simulator screen. Returns { url, path }.
The MCP adapter returns this as a visible image.
Requires a Pro JWT token — pass it via the token param or call simulator-server first.
If screenshot times out, the simulator-server likely has no token; restart with a token.`,
  inputSchema,
  outputHint: "image",
  async execute(input, signal) {
    const entry = await ensureServer(input.udid, input.token, signal);
    const timeout = AbortSignal.timeout(16_000);
    return httpScreenshot(entry, input.rotation, timeout);
  },
};
