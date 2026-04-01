import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
  fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
  toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
  toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

export const gestureSwipeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { swiped: boolean; timestampMs: number }
> = {
  id: "gesture-swipe",
  description: `Send a smooth straight-line swipe gesture between two normalized coordinates on the simulator screen.
Use when scrolling lists, swiping between pages, or performing any linear drag. All positions are 0.0–1.0 screen fractions (not pixels). For complex paths use gesture-custom; for pinch use gesture-pinch.

Parameters: udid; fromX, fromY — start position; toX, toY — end position; durationMs — optional gesture duration in ms (default 300).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } — swipes up (scrolls content down).
Returns { swiped: true, timestampMs }. Fails if the simulator-server cannot start or the simulator is not booted.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    let timestampMs = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = params.fromX + (params.toX - params.fromX) * t;
      const y = params.fromY + (params.toY - params.fromY) * t;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();
      sendCommand(api, {
        cmd: "touch",
        type,
        x,
        y,
        second_x: null,
        second_y: null,
      });
      if (i < steps) await sleep(16);
    }

    return { swiped: true, timestampMs };
  },
};
