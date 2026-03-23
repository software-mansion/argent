import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../utils/gesture-utils";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  centerX: z
    .number()
    .describe("Center of pinch, horizontal position (0.0–1.0)"),
  centerY: z
    .number()
    .describe("Center of pinch, vertical position (0.0–1.0)"),
  startDistance: z
    .number()
    .describe(
      "Initial distance between the two fingers (0.0–1.0 normalized). " +
        "Use a larger startDistance than endDistance to pinch in (zoom out)."
    ),
  endDistance: z
    .number()
    .describe(
      "Final distance between the two fingers (0.0–1.0 normalized). " +
        "Use a larger endDistance than startDistance to pinch out (zoom in)."
    ),
  angle: z
    .number()
    .optional()
    .describe(
      "Axis angle in degrees along which the fingers are placed (default 0 = horizontal)."
    ),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

export const gesturePinchTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { pinched: boolean; timestampMs: number }
> = {
  id: "gesture-pinch",
  description: `Perform a smooth two-finger pinch gesture.
startDistance > endDistance = pinch in (zoom out).
startDistance < endDistance = pinch out (zoom in).
Auto-generates interpolated frames at ~60fps for a natural feel.
The angle parameter controls the axis (0 = horizontal, 90 = vertical).`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    const angleDeg = params.angle ?? 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    let timestampMs = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const dist = params.startDistance + (params.endDistance - params.startDistance) * t;
      const halfDist = dist / 2;

      const x1 = params.centerX - halfDist * cosA;
      const y1 = params.centerY - halfDist * sinA;
      const x2 = params.centerX + halfDist * cosA;
      const y2 = params.centerY + halfDist * sinA;

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      sendTouchEvent(api, type, x1, y1, x2, y2);
      if (i < steps) await sleep(16);
    }

    return { pinched: true, timestampMs };
  },
};
