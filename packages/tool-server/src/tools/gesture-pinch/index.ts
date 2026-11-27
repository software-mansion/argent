import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { harmonyConnectKey, isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { ensureDep } from "../../utils/check-deps";
import { pinchContacts, sendTouchEvent } from "../../utils/gesture-utils";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { getViewport, touchPaths } from "../../utils/ios-device/runner-commands";
import { pinchPaths } from "../../utils/ios-device/touch-paths";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  holdUitestQueue,
  HARMONY_DISPLAY_TIMEOUT_MS,
  remainingBudget,
  toDevicePoint,
} from "../../utils/harmony-uitest";
import { sleep } from "../../utils/timing";

interface Result {
  pinched: boolean;
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
  harmony: { device: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id from `list-devices` (iOS UDID<flag:harmonyos>, HarmonyOS id,</flag:harmonyos> or Android serial)."
    ),
  centerX: z.number().describe("Normalized center x."),
  centerY: z.number().describe("Normalized center y."),
  startDistance: z.number().describe("Initial normalized finger distance."),
  endDistance: z.number().describe("Final normalized finger distance (> start = zoom in)."),
  endCenterX: z.number().optional().describe("Optional final center x (centroid drifts linearly)."),
  endCenterY: z.number().optional().describe("Optional final center y."),
  angle: z
    .number()
    .optional()
    .describe("Finger axis angle in degrees (0 = horizontal, 90 = vertical)."),
  durationMs: z
    .number()
    .optional()
    .describe(
      "Duration in ms (default 300)<flag:harmonyos>; clamped to 1–15000ms on HarmonyOS</flag:harmonyos>."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const gesturePinchTool: ToolDefinition<Params, Result> = {
  id: "gesture-pinch",
  description: `Send a two-finger pinch-to-zoom gesture in normalized [0,1] coords (\`startDistance < endDistance\` zooms in, e.g. 0.2→0.6; \`>\` zooms out).
Use when zooming maps, photos, or zoomable views (use \`gesture-rotate\` to rotate).
Returns \`{ pinched: true, timestampMs, reactivated? }\` (on physical iOS, \`reactivated: true\` means re-describe). Fails if the backend<flag:harmonyos> (\`hdc\` on HarmonyOS)</flag:harmonyos> is unreachable or a physical iPhone app is not in portrait.`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) =>
      `Pinching ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Pinched ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to pinch: ${failureSignal.error_code}`,
  },
  capability,
  // A physical iPhone's first call waits out the runner build, past the MCP fetch timeout,
  // whose abort replays the call: the gesture would land once per replay.
  longRunning: true,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    // No simulator-server controller exists for HarmonyOS.
    if (device.platform === "harmony") return {};
    if (isIosPhysicalDevice(device)) return { iosDeviceRunner: iosDeviceRunnerRef(device) };
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params, ctx) {
    const duration = params.durationMs ?? 300;
    const device = resolveDevice(params.udid);
    // `uinput -T -m` moves both contacts in one call; a second call would
    // replace the first finger, not add to it.
    if (device.platform === "harmony") {
      await ensureDep("hdc");
      const connectKey = harmonyConnectKey(device.id);
      const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
      // Prefilter without queueing; the trusted check is inside the hold.
      const display = await harmonyDisplay(connectKey);
      assertHarmonyDisplayReady(display, "pinch");
      let timestampMs = 0;
      await holdUitestQueue(
        connectKey,
        deadline,
        async (ui) => {
          // Re-read: the geometry of a foldable may have changed while queued.
          const live = await harmonyDisplay(
            connectKey,
            Math.min(
              HARMONY_DISPLAY_TIMEOUT_MS,
              remainingBudget(connectKey, deadline, "the display re-read")
            )
          );
          assertHarmonyDisplayReady(live, "pinch");
          const start = pinchContacts(params, 0);
          const end = pinchContacts(params, 1);
          timestampMs = Date.now();
          await ui.multiTouchMove(
            [
              {
                from: toDevicePoint(start.first.x, start.first.y, live),
                to: toDevicePoint(end.first.x, end.first.y, live),
              },
              {
                from: toDevicePoint(start.second.x, start.second.y, live),
                to: toDevicePoint(end.second.x, end.second.y, live),
              },
            ],
            duration
          );
        },
        ctx?.signal
      );
      return { pinched: true, timestampMs };
    }
    // Hardware fingers go through the runner as two timed paths, played at once.
    if (isIosPhysicalDevice(device)) {
      const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const viewport = await getViewport(runner, bundleId);
      const timestampMs = Date.now();
      const { reactivated } = await touchPaths(
        runner,
        bundleId,
        pinchPaths(params, viewport, duration)
      );
      const fronted = viewport.reactivated === true || reactivated;
      return { pinched: true, timestampMs, ...(fronted ? { reactivated: true as const } : {}) };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const steps = Math.max(1, Math.round(duration / 16));

    let timestampMs = 0;
    let warning: string | undefined;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const { first, second } = pinchContacts(params, t);

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      const sent = await sendTouchEvent(api, type, first.x, first.y, second.x, second.y);
      // Only the Down resolves the panel; the rest of the sequence keeps it.
      if (type === "Down") warning = sent.warning;
      if (i < steps) await sleep(16);
    }

    return { pinched: true, timestampMs, ...(warning !== undefined ? { warning } : {}) };
  },
};
