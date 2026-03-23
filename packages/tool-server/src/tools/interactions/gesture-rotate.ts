import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../utils/gesture-utils";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  centerX: z
    .number()
    .describe("Center of rotation, horizontal position (0.0–1.0)"),
  centerY: z
    .number()
    .describe("Center of rotation, vertical position (0.0–1.0)"),
  radius: z
    .number()
    .describe("Distance from center to each finger (0.0–1.0 normalized)"),
  startAngle: z
    .number()
    .describe("Starting angle in degrees (0 = right, 90 = down)"),
  endAngle: z
    .number()
    .describe("Ending angle in degrees. endAngle > startAngle = clockwise."),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

export const gestureRotateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { rotated: boolean; timestampMs: number }
> = {
  id: "gesture-rotate",
  description: `Perform a smooth two-finger rotation gesture.
Two fingers are placed opposite each other at the given radius from the center,
then rotated from startAngle to endAngle.
endAngle > startAngle = clockwise rotation.
Auto-generates interpolated frames at ~60fps for a natural feel.`,
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
      const angleDeg =
        params.startAngle + (params.endAngle - params.startAngle) * t;
      const angleRad = (angleDeg * Math.PI) / 180;

      const x1 = params.centerX + params.radius * Math.cos(angleRad);
      const y1 = params.centerY + params.radius * Math.sin(angleRad);
      const x2 = params.centerX - params.radius * Math.cos(angleRad);
      const y2 = params.centerY - params.radius * Math.sin(angleRad);

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      sendTouchEvent(api, type, x1, y1, x2, y2);
      if (i < steps) await sleep(16);
    }

    return { rotated: true, timestampMs };
  },
};
