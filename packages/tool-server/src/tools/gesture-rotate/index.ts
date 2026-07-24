import { z } from "zod";
import {
  zodObjectToJsonSchema,
  type ToolCapability,
  type ToolContext,
  type ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendTouchEvent } from "../../utils/gesture-utils";
import { sleep } from "../../utils/timing";

const zodSchema = z
  .object({
    udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
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
      .optional()
      .describe(
        "Distance from center to each finger: normalized 0.0–1.0 (fraction of screen, not pixels). " +
          "E.g. 0.15 = fingers placed 15% of screen away from center. One value for both axes, so on " +
          "a non-square screen the orbit is a physical ellipse — pass radiusX+radiusY instead for a " +
          "true circle. Required unless radiusX and radiusY are given."
      ),
    radiusX: z
      .number()
      .optional()
      .describe(
        "Per-axis finger distance, horizontal: normalized 0.0–1.0 fraction of screen WIDTH. Give " +
          "both radiusX and radiusY (they override radius) with radiusX·screenWidth = " +
          "radiusY·screenHeight for a physically circular orbit — constant finger separation, no " +
          "pinch coupled into the turn."
      ),
    radiusY: z
      .number()
      .optional()
      .describe(
        "Per-axis finger distance, vertical: normalized 0.0–1.0 fraction of screen HEIGHT. " +
          "Always paired with radiusX — see radiusX."
      ),
    startAngle: z.number().describe("Starting angle in degrees (0 = right, 90 = down)"),
    endAngle: z.number().describe("Ending angle in degrees. endAngle > startAngle = clockwise."),
    durationMs: z
      .number()
      .optional()
      .describe("Total gesture duration in milliseconds (default 300)"),
  })
  .refine((p) => (p.radiusX === undefined) === (p.radiusY === undefined), {
    message: "radiusX and radiusY must be given together (one physical radius, two normalizations)",
  })
  .refine((p) => p.radius !== undefined || p.radiusX !== undefined, {
    message: "Pass radius, or both radiusX and radiusY.",
  });

// Explicit because the auto-derived JSON Schema loses the .refine() cross-field
// rules — the anyOf re-encodes both: the per-axis pair together, or radius with
// neither half of the pair.
const inputSchema = {
  ...zodObjectToJsonSchema(zodSchema),
  anyOf: [
    { required: ["radiusX", "radiusY"] },
    {
      required: ["radius"],
      not: { anyOf: [{ required: ["radiusX"] }, { required: ["radiusY"] }] },
    },
  ],
};

type Params = z.infer<typeof zodSchema>;

interface Result {
  rotated: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gestureRotateTool: ToolDefinition<Params, Result> = {
  id: "gesture-rotate",
  description: `Send a two-finger circular arc gesture to rotate on-screen content by a specified angle. Two fingers are placed opposite each other at a fixed radius from the center, then swept from startAngle to endAngle degrees. All positions and radii are normalized 0.0–1.0 (fractions of screen width/height, not pixels)—same coordinate space as gesture-tap and gesture-swipe.
endAngle > startAngle = clockwise rotation. Typical values: radius 0.15, startAngle 0, endAngle 90 for a 90° clockwise turn. A single radius applies to both axes, so on a non-square screen it traces a physical ellipse (finger separation varies through the turn); pass radiusX+radiusY (fractions of width/height with radiusX·width = radiusY·height) for a physically circular orbit instead.
Auto-generates interpolated frames at ~60fps.
Unlike gesture-pinch which moves fingers linearly to zoom, this orbits fingers in an arc to change orientation.
Use when you need to rotate a map, image picker, or any rotateable UI element. Returns { rotated: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  inputSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx?: ToolContext) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    // The refine guarantees radius exists whenever the per-axis pair is absent.
    const radiusX = params.radiusX ?? params.radius!;
    const radiusY = params.radiusY ?? params.radius!;

    let timestampMs = 0;
    // Last dispatched finger positions, so an abort can lift from where the
    // fingers actually are.
    let lastX1 = 0;
    let lastY1 = 0;
    let lastX2 = 0;
    let lastY2 = 0;

    for (let i = 0; i <= steps; i++) {
      if (ctx?.signal?.aborted) {
        // Once Down has been dispatched, the synthetic fingers are on the glass —
        // send a terminal Up so a cancelled run doesn't leave them held down.
        if (i > 0) sendTouchEvent(api, "Up", lastX1, lastY1, lastX2, lastY2);
        const err = new Error(
          `gesture-rotate aborted — cancelled mid-gesture after ${i} of ${steps + 1} frames`
        );
        err.name = "AbortError";
        throw err;
      }

      const t = i / steps;
      const angleDeg = params.startAngle + (params.endAngle - params.startAngle) * t;
      const angleRad = (angleDeg * Math.PI) / 180;

      const x1 = params.centerX + radiusX * Math.cos(angleRad);
      const y1 = params.centerY + radiusY * Math.sin(angleRad);
      const x2 = params.centerX - radiusX * Math.cos(angleRad);
      const y2 = params.centerY - radiusY * Math.sin(angleRad);

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      sendTouchEvent(api, type, x1, y1, x2, y2);
      lastX1 = x1;
      lastY1 = y1;
      lastX2 = x2;
      lastY2 = y2;
      if (i < steps) await sleep(16);
    }

    return { rotated: true, timestampMs };
  },
};
