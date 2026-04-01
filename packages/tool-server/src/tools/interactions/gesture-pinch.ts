import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../utils/gesture-utils";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
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
  description: `Send a smooth two-finger pinch gesture to zoom in or out on a specific area of the simulator screen.
Use when you need to scale content with a two-finger pinch — e.g. zooming into a map region, enlarging a photo, or triggering a zoom gesture on a web view. Use gesture-tap for single taps, gesture-swipe for scrolling, gesture-rotate for rotation.

Parameters: udid; centerX, centerY — normalized pinch center 0.0–1.0 (e.g. 0.5, 0.5 for screen center); startDistance, endDistance — initial and final finger separation as screen fraction (startDistance > endDistance = zoom out; startDistance < endDistance = zoom in); angle — axis in degrees (default 0 = horizontal); durationMs — optional ms (default 300).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "centerX": 0.5, "centerY": 0.5, "startDistance": 0.2, "endDistance": 0.6 } — zoom in at center.
Returns { pinched: true, timestampMs }. Fails if the simulator-server cannot start or the simulator is not booted.`,
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
