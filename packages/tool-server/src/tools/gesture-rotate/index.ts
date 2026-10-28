import { z } from "zod";
import { type ToolCapability, type ToolContext, type ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendTouchEvent } from "../../utils/gesture-utils";
import { sleep } from "../../utils/timing";

interface Result {
  rotated: boolean;
  timestampMs: number;
  /**
   * Foldable iOS simulators only: the panel the device renders to could not
   * be resolved, so the gesture went to the cover panel. Says why and what to check.
   */
  warning?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

const zodSchema = z
  .object({
    udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
    centerX: z.number().describe("Center of rotation, horizontal."),
    centerY: z.number().describe("Center of rotation, vertical."),
    radius: z.number().optional().describe("Distance from the center to each finger."),
    radiusX: z
      .number()
      .optional()
      .describe("Finger distance along the horizontal axis, as a fraction of screen WIDTH."),
    radiusY: z
      .number()
      .optional()
      .describe("Finger distance along the vertical axis, as a fraction of screen HEIGHT."),
    startAngle: z.number().describe("Starting angle in degrees (0 = right, 90 = down)"),
    endAngle: z.number().describe("Ending angle in degrees."),
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

type Params = z.infer<typeof zodSchema>;

export const gestureRotateTool: ToolDefinition<Params, Result> = {
  id: "gesture-rotate",
  description: `Send a two-finger circular arc gesture to rotate on-screen content by a specified angle. Two fingers are placed opposite each other at a fixed radius from the center, then swept from startAngle to endAngle degrees (endAngle > startAngle = clockwise). All positions and radii are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same coordinate space as gesture-tap and gesture-swipe. Typical values: radius 0.15, startAngle 0, endAngle 90 for a 90° clockwise turn.
Size the orbit with radius, or with radiusX and radiusY together (the pair overrides radius); one half of the pair alone, or none of the three, is rejected. A single radius traces a physical ellipse on a non-square screen (finger separation varies through the turn); for a physically circular orbit, pass radiusX and radiusY with radiusX·width = radiusY·height.
Unlike gesture-pinch which moves fingers linearly to zoom, this orbits fingers in an arc to change orientation.
Use when you need to rotate a map, image picker, or any rotateable UI element. Returns { rotated: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) => {
      const degrees = Math.abs(params.endAngle - params.startAngle);
      const direction = params.endAngle > params.startAngle ? "clockwise" : "counterclockwise";
      return `Rotating gesture ${degrees}° ${direction}`;
    },
    completedMsg: ({ params }) => {
      const degrees = Math.abs(params.endAngle - params.startAngle);
      const direction = params.endAngle > params.startAngle ? "clockwise" : "counterclockwise";
      return `Rotated gesture ${degrees}° ${direction}`;
    },
    failedMsg: ({ failureSignal }) => `Failed to rotate gesture: ${failureSignal.error_code}`,
  },
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx?: ToolContext) {
    const api = services.simulatorServer as SimulatorServerApi;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    // Refines guarantee radius is set whenever the per-axis pair is absent.
    const radiusX = params.radiusX ?? params.radius!;
    const radiusY = params.radiusY ?? params.radius!;

    let timestampMs = 0;
    let warning: string | undefined;
    // Last dispatched positions, so an abort lifts from where the fingers are.
    let lastX1 = 0;
    let lastY1 = 0;
    let lastX2 = 0;
    let lastY2 = 0;

    for (let i = 0; i <= steps; i++) {
      if (ctx?.signal?.aborted) {
        const err = new Error(
          `gesture-rotate aborted — cancelled mid-gesture after ${i} of ${steps + 1} frames`
        );
        err.name = "AbortError";
        // Fingers are on the glass from i=0 on; lift them so a cancelled run
        // doesn't leave them held down. Best effort, as in gesture-swipe: a
        // refused lift rides along as `cause` instead of masking the abort.
        if (i > 0) {
          try {
            await sendTouchEvent(api, "Up", lastX1, lastY1, lastX2, lastY2);
          } catch (liftErr) {
            err.cause = liftErr;
          }
        }
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

      const sent = await sendTouchEvent(api, type, x1, y1, x2, y2);
      // Only the Down resolves the panel; the rest of the sequence keeps it.
      if (type === "Down") warning = sent.warning;
      lastX1 = x1;
      lastY1 = y1;
      lastX2 = x2;
      lastY2 = y2;
      if (i < steps) await sleep(16);
    }

    return { rotated: true, timestampMs, ...(warning !== undefined ? { warning } : {}) };
  },
};
