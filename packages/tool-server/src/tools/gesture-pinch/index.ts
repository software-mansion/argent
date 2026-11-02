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

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID<flag:harmonyos>, HarmonyOS id,</flag:harmonyos> or Android serial)."
    ),
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
    .describe(
      "Total gesture duration in milliseconds (default 300)<flag:harmonyos>. On HarmonyOS the device runs the whole move itself and takes this as wall-clock time, clamped to the 1–15000ms range `uinput` accepts.</flag:harmonyos>"
    ),
});

type Params = z.infer<typeof zodSchema>;

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

export const gesturePinchTool: ToolDefinition<Params, Result> = {
  id: "gesture-pinch",
  interaction: {
    startedMsg: ({ params }) =>
      `Pinching ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Pinched ${params.endDistance > params.startDistance ? "out" : "in"} at (${Math.round(params.centerX * 100)}%, ${Math.round(params.centerY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to pinch: ${failureSignal.error_code}`,
  },
  description: `Execute a pinch-to-zoom gesture by moving two fingers toward or away from a center point to change the scale of on-screen content. All positions and distances are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same coordinate space as gesture-tap and gesture-swipe.
startDistance > endDistance = pinch in (zoom out). startDistance < endDistance = pinch out (zoom in).
Typical values: startDistance 0.2, endDistance 0.6 for a zoom-in pinch at screen center.
Auto-generates interpolated frames at ~60fps<flag:harmonyos> on iOS and Android; HarmonyOS takes both fingers' endpoints in one call and interpolates them on-device</flag:harmonyos>. The angle parameter controls the axis (0 = horizontal, 90 = vertical). Optional endCenterX/endCenterY drift the centroid linearly over the gesture (omitted = fixed center).
Use when you need to zoom in or out on a map, image, or zoomable view. Physical iPhones play both fingers through the runner as one event stream. Returns { pinched: true, timestampMs }. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the simulator-server / emulator backend<flag:harmonyos>, or \`hdc\` on HarmonyOS,</flag:harmonyos> is not reachable for the given device, or on a physical iPhone when the app is not drawn in portrait.`,
  zodSchema,
  capability,
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
