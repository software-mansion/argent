import { z } from "zod";
import {
  type ServiceRef,
  type ToolCapability,
  type ToolContext,
  type ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { rotateContacts, sendTouchEvent } from "../../utils/gesture-utils";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { getViewport, touchPaths } from "../../utils/ios-device/runner-commands";
import { rotatePaths } from "../../utils/ios-device/touch-paths";
import { sleep } from "../../utils/timing";

interface Result {
  rotated: boolean;
  timestampMs: number;
  /**
   * Foldable iOS simulators only: the panel the device renders to could not
   * be resolved, so the gesture went to the cover panel. Says why and what to check.
   */
  warning?: string;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to run this gesture, so the foreground screen changed as a
   * side effect. Set only when true.
   */
  reactivated?: true;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

const zodSchema = z
  .object({
    udid: z.string().describe("Device id from `list-devices` (iOS UDID or Android serial)."),
    centerX: z.number().describe("Normalized rotation center x."),
    centerY: z.number().describe("Normalized rotation center y."),
    radius: z.number().optional().describe("Normalized finger orbit radius (e.g. 0.15)."),
    radiusX: z
      .number()
      .optional()
      .describe("Horizontal radius fraction of screen width (pair with `radiusY`)."),
    radiusY: z
      .number()
      .optional()
      .describe("Vertical radius fraction of screen height (pair with `radiusX`)."),
    startAngle: z.number().describe("Start angle in degrees (0 = right, 90 = down)."),
    endAngle: z.number().describe("End angle in degrees (> startAngle = clockwise)."),
    durationMs: z.number().optional().describe("Duration in ms (default 300)."),
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
  description: `Send a two-finger circular arc gesture in normalized [0,1] coords to rotate content from \`startAngle\` to \`endAngle\`. Pass \`radius\`, or \`radiusX\`+\`radiusY\` with \`radiusX·width = radiusY·height\` for a circular physical orbit (a single radius or equal values trace an ellipse on a non-square screen; one half of the pair alone is rejected).
Use when rotating a map, photo, or canvas (use \`gesture-pinch\` for zoom).
Returns \`{ rotated: true, timestampMs, reactivated? }\` (on physical iOS, \`reactivated: true\` means re-describe). Fails if the backend is unreachable or a physical iPhone app is not in portrait.`,
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
  // A physical iPhone's first call waits out the runner build, past the MCP fetch timeout,
  // whose abort replays the call: the gesture would land once per replay.
  longRunning: true,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return isIosPhysicalDevice(device)
      ? { iosDeviceRunner: iosDeviceRunnerRef(device) }
      : { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params, ctx?: ToolContext) {
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    // Refines guarantee radius is set whenever the per-axis pair is absent.
    const radiusX = params.radiusX ?? params.radius!;
    const radiusY = params.radiusY ?? params.radius!;
    const geometry = { ...params, radiusX, radiusY };

    // Hardware fingers go through the runner as two timed paths, played at once.
    const device = resolveDevice(params.udid);
    if (isIosPhysicalDevice(device)) {
      const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const viewport = await getViewport(runner, bundleId);
      const timestampMs = Date.now();
      const { reactivated } = await touchPaths(
        runner,
        bundleId,
        rotatePaths(geometry, viewport, duration)
      );
      const fronted = viewport.reactivated === true || reactivated;
      return { rotated: true, timestampMs, ...(fronted ? { reactivated: true as const } : {}) };
    }

    const api = services.simulatorServer as SimulatorServerApi;

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

      const {
        first: { x: x1, y: y1 },
        second: { x: x2, y: y2 },
      } = rotateContacts(geometry, i / steps);

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
