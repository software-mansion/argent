import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

export const rotateTool: Tool<
  typeof inputSchema,
  { orientation: string }
> = {
  name: "rotate",
  description: `Rotate the simulator to a given orientation.`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    sendCommand(entry, { cmd: "rotate", direction: input.orientation });
    return { orientation: input.orientation };
  },
};
