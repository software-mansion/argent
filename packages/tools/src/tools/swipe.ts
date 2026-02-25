import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  fromX: z.number().describe("Start horizontal position (0.0–1.0)"),
  fromY: z.number().describe("Start vertical position (0.0–1.0)"),
  toX: z.number().describe("End horizontal position (0.0–1.0)"),
  toY: z.number().describe("End vertical position (0.0–1.0)"),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

export const swipeTool: Tool<typeof inputSchema, { swiped: boolean }> = {
  name: "swipe",
  description: `Perform a smooth swipe gesture between two points.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Swipe down (fromY < toY) to scroll content up.`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    const duration = input.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = input.fromX + (input.toX - input.fromX) * t;
      const y = input.fromY + (input.toY - input.fromY) * t;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      sendCommand(entry, {
        cmd: "touch",
        type,
        x,
        y,
        second_x: null,
        second_y: null,
      });
      if (i < steps) await sleep(16);
    }

    return { swiped: true };
  },
};
