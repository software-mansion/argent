import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  harmonySwipe,
  toDevicePoint,
} from "../../utils/harmony-uitest";
import { ensureDep } from "../../utils/check-deps";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `settle` swipe. The finger follows 1-(1-t)^n rather
// than a straight line, so it decelerates into the end point and lifts at ~0
// velocity — the scroll view then skips its fling. Cubic gives a fast glide that
// flattens over the final frames; a higher exponent would linger longer at rest.
const SETTLE_EASE_EXPONENT = 3;

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or HarmonyOS id)."),
  fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
  fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
  toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
  toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
  durationMs: z
    .number()
    .optional()
    .describe(
      "Total gesture duration in milliseconds (default 300). On HarmonyOS this is converted to a `uitest` velocity and clamped to the 200–40000 range the binary accepts, so a very slow or very fast request lands at the nearest velocity `uitest` will take rather than the exact duration asked for."
    ),
  settle: z
    .boolean()
    .optional()
    .describe(
      "Momentum-free swipe: decelerate into the end point (ease-out) so the OS reads ~0 release velocity and applies little to no fling. Use for scroll-to-element loops; default false (a natural flinging swipe)."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  swiped: boolean;
  timestampMs: number;
}

// Touch platforms only. A desktop renderer has no touch swipe: a mouse drag
// selects text instead of scrolling, so Chromium callers use the dedicated
// `gesture-scroll` tool (wheel-based) and the capability gate rejects this
// one with a clear error rather than silently doing the wrong thing.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  harmony: { device: true },
};

export const gestureSwipeTool: ToolDefinition<Params, Result> = {
  id: "gesture-swipe",
  interaction: {
    startedMsg: ({ params }) =>
      `Swiping from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Swiped from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to swipe: ${failureSignal.error_code}`,
  },
  description: `Execute a smooth swipe / drag touch gesture between two points on the device (iOS simulator, Android emulator, or HarmonyOS device). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
On iOS and Android, generates interpolated Move events for a natural feel (~60fps); HarmonyOS takes the whole gesture in one call and interpolates it on-device.
Swipe up (fromY > toY) to scroll content down.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Not supported on Chromium — use gesture-scroll there instead.
Pass settle:true for a momentum-free swipe that lands exactly where the finger lifts (no fling), when you need a deterministic scroll distance. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend, or \`hdc\` on HarmonyOS, is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    // HarmonyOS swipes go over hdc; resolving the iOS/Android-only blueprint
    // would fail the swipe before it runs — the factory refuses any platform
    // but those two.
    if (device.platform === "harmony") return {};
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const settle = params.settle ?? false;
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);
    // HarmonyOS has no simulator-server controller: the whole gesture is one
    // `uitest uiInput` call, which owns its own interpolation on-device, so
    // there is no per-frame Move train to emit here.
    if (device.platform === "harmony") {
      await ensureDep("hdc");
      const connectKey = harmonyConnectKey(device.id);
      // One deadline for the geometry read and the injection it feeds, so the
      // pair stays under the MCP layer's abort-and-replay cap.
      const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
      const display = await harmonyDisplay(connectKey);
      // A swipe against a panel that is suspended, or that the render service
      // could not size, reports `No Error` and lands nowhere.
      assertHarmonyDisplayReady(display, "swipe");
      const fromPx = toDevicePoint(params.fromX, params.fromY, display);
      const toPx = toDevicePoint(params.toX, params.toY, display);
      const distance = Math.hypot(toPx.x - fromPx.x, toPx.y - fromPx.y);
      const seconds = Math.max(duration, 1) / 1000;
      await harmonySwipe(
        connectKey,
        settle ? "swipe" : "fling",
        fromPx,
        toPx,
        distance / seconds,
        deadline - Date.now()
      );
      return { swiped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const steps = Math.max(1, Math.round(duration / 16));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // A plain swipe advances linearly; a `settle` swipe eases-out so the finger
      // decelerates into the end point and lifts at ~0 velocity (no fling). The
      // shrinking end-of-curve steps stay distinct, non-coalescible moves whose
      // dx/dt genuinely decays — unlike a train of identical "hold" samples,
      // which UIKit coalesces away, leaving the fast pre-hold velocity to fling.
      // Ease-out also keeps every sample between the start and end point, so it
      // never runs off-screen the way a beyond-the-end hold would for a swipe
      // that already finishes at an edge.
      const progress = settle ? 1 - Math.pow(1 - t, SETTLE_EASE_EXPONENT) : t;
      const x = params.fromX + (params.toX - params.fromX) * progress;
      const y = params.fromY + (params.toY - params.fromY) * progress;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      sendCommand(api, {
        cmd: "touch",
        type,
        x,
        y,
        second_x: null,
        second_y: null,
      });
      if (i < steps) await sleep(16);
    }

    return { swiped: true, timestampMs };
  },
};
