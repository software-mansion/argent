import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../utils/gesture-utils";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  centerX: z
    .number()
    .describe(
      "Center of rotation, horizontal: normalized 0.0–1.0 (fraction of screen width, not pixels)"
    ),
  centerY: z
    .number()
    .describe(
      "Center of rotation, vertical: normalized 0.0–1.0 (fraction of screen height, not pixels)"
    ),
  radius: z
    .number()
    .describe(
      "Distance from center to each finger: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.15 = fingers placed 15% of screen away from center."
    ),
  startAngle: z.number().describe("Starting angle in degrees (0 = right, 90 = down)"),
  endAngle: z.number().describe("Ending angle in degrees. endAngle > startAngle = clockwise."),
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
  description: `Send a smooth two-finger rotation gesture to spin content on the simulator screen around a center point.
Use when triggering an iOS rotation gesture — e.g. rotating a map orientation, spinning an image, or testing a UIRotationGestureRecognizer. Use gesture-pinch for zooming, gesture-swipe for scrolling, gesture-tap for tapping.

Parameters: udid; centerX, centerY — normalized rotation center 0.0–1.0 (e.g. 0.5, 0.5); radius — normalized finger distance from center (e.g. 0.15 = 15% of screen); startAngle, endAngle — in degrees (0 = right, 90 = down, endAngle > startAngle = clockwise); durationMs — optional ms (default 300).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "centerX": 0.5, "centerY": 0.5, "radius": 0.15, "startAngle": 0, "endAngle": 90 } — 90° clockwise rotation.
Returns { rotated: true, timestampMs }. Fails if the simulator-server cannot start or the simulator is not booted.`,
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
      const angleDeg = params.startAngle + (params.endAngle - params.startAngle) * t;
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
