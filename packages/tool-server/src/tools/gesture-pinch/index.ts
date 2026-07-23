import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendTouchEvent } from "../../utils/gesture-utils";
import { sleep } from "../../utils/timing";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
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
  endCenterX: z
    .number()
    .optional()
    .describe(
      "Final horizontal center of the pinch: normalized 0.0–1.0. When set, the centroid drifts " +
        "linearly from centerX to endCenterX over the gesture (e.g. to keep expanding fingers " +
        "on-screen near an edge). Omit for a fixed center."
    ),
  endCenterY: z
    .number()
    .optional()
    .describe(
      "Final vertical center of the pinch: normalized 0.0–1.0. When set, the centroid drifts " +
        "linearly from centerY to endCenterY over the gesture. Omit for a fixed center."
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

type Params = z.infer<typeof zodSchema>;

interface Result {
  pinched: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gesturePinchTool: ToolDefinition<Params, Result> = {
  id: "gesture-pinch",
  description: `Execute a pinch-to-zoom gesture by moving two fingers toward or away from a center point to change the scale of on-screen content. All positions and distances are normalized 0.0–1.0 (fractions of screen width/height, not pixels)—same coordinate space as gesture-tap and gesture-swipe.
startDistance > endDistance = pinch in (zoom out). startDistance < endDistance = pinch out (zoom in).
Typical values: startDistance 0.2, endDistance 0.6 for a zoom-in pinch at screen center.
Auto-generates interpolated frames at ~60fps. The angle parameter controls the axis (0 = horizontal, 90 = vertical). Optional endCenterX/endCenterY drift the centroid linearly over the gesture (omitted = fixed center).
Use when you need to zoom in or out on a map, image, or zoomable view. Returns { pinched: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    const angleDeg = params.angle ?? 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const endCenterX = params.endCenterX ?? params.centerX;
    const endCenterY = params.endCenterY ?? params.centerY;

    let timestampMs = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const dist = params.startDistance + (params.endDistance - params.startDistance) * t;
      const halfDist = dist / 2;
      const cx = params.centerX + (endCenterX - params.centerX) * t;
      const cy = params.centerY + (endCenterY - params.centerY) * t;

      const x1 = cx - halfDist * cosA;
      const y1 = cy - halfDist * sinA;
      const x2 = cx + halfDist * cosA;
      const y2 = cy + halfDist * sinA;

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      sendTouchEvent(api, type, x1, y1, x2, y2);
      if (i < steps) await sleep(16);
    }

    return { pinched: true, timestampMs };
  },
};
