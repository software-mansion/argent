import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../utils/gesture-utils";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  centerX: z
    .number()
    .describe(
      "Center of pinch, horizontal: normalized 0.0–1.0 (fraction of screen width, not pixels)"
    ),
  centerY: z
    .number()
    .describe(
      "Center of pinch, vertical: normalized 0.0–1.0 (fraction of screen height, not pixels)"
    ),
  startDistance: z
    .number()
    .describe(
      "Initial distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.2 = fingers 20% of screen apart. " +
        "Use a larger startDistance than endDistance to pinch in (zoom out)."
    ),
  endDistance: z
    .number()
    .describe(
      "Final distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.6 = fingers 60% of screen apart. " +
        "Use a larger endDistance than startDistance to pinch out (zoom in)."
    ),
  angle: z
    .number()
    .optional()
    .describe("Axis angle in degrees along which the fingers are placed (default 0 = horizontal)."),
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
  description: `Two-finger pinch-to-zoom at a center point. All positions and distances are normalized 0.0–1.0 (fractions of the screen, not pixels).
startDistance > endDistance = pinch in (zoom out); startDistance < endDistance = pinch out (zoom in).
Typical zoom-in: startDistance 0.2, endDistance 0.6 at screen center.
\`angle\` controls the axis in degrees (0 = horizontal, 90 = vertical).
Use to zoom a map, image, or zoomable view. Returns { pinched, timestampMs }. Fails if the target device is not booted.`,
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
