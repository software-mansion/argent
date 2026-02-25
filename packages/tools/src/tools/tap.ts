import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  x: z.number().describe("Horizontal position (0.0=left, 1.0=right)"),
  y: z.number().describe("Vertical position (0.0=top, 1.0=bottom)"),
});

export const tapTool: Tool<typeof inputSchema, { tapped: boolean }> = {
  name: "tap",
  description: `Tap the simulator screen at normalized coordinates (0.0=left/top, 1.0=right/bottom).
Sends a Down event followed by an Up event at the same point.`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    sendCommand(entry, {
      cmd: "touch",
      type: "Down",
      x: input.x,
      y: input.y,
      second_x: null,
      second_y: null,
    });
    await sleep(50);
    sendCommand(entry, {
      cmd: "touch",
      type: "Up",
      x: input.x,
      y: input.y,
      second_x: null,
      second_y: null,
    });
    return { tapped: true };
  },
};
