import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "../simulator-api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
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

export const swipeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { swiped: boolean }
> = {
  id: "swipe",
  description: `Perform a smooth swipe gesture between two points.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Swipe down (fromY < toY) to scroll content up.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = params.fromX + (params.toX - params.fromX) * t;
      const y = params.fromY + (params.toY - params.fromY) * t;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
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

    return { swiped: true };
  },
};
