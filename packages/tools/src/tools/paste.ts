import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  text: z.string().describe("Text to paste into the focused input field"),
});

export const pasteTool: Tool<typeof inputSchema, { pasted: boolean }> = {
  name: "paste",
  description: `Paste text into the focused input field on the simulator.
Faster and more reliable than simulating individual key presses.`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    sendCommand(entry, { cmd: "paste", text: input.text });
    return { pasted: true };
  },
};
