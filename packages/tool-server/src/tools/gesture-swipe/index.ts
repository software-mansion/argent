import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { dragBetween, getViewport, toPoints } from "../../utils/ios-device/runner-commands";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `settle` swipe: cubic glides fast then flattens over
// the final frames; a higher exponent would linger longer at rest.
const SETTLE_EASE_EXPONENT = 3;

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
  fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
  toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
  toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
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
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to run this swipe, so the foreground screen changed as a
   * side effect. Set only when true.
   */
  reactivated?: true;
}

// Touch platforms only: on a desktop renderer a mouse drag selects text instead
// of scrolling, so Chromium callers use `gesture-scroll` (wheel-based) instead.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
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
  description: `Execute a smooth swipe / drag touch gesture between two points on the device (iOS simulator or physical device, or Android emulator). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Not supported on Chromium — use gesture-scroll there instead.
On a physical iOS device, an edge gesture (e.g. a back-swipe) needs the start point at exactly the edge (fromX 0); a start a few thousandths in reports success without triggering the OS gesture.
Pass settle:true for a momentum-free swipe that lands exactly where the finger lifts (no fling), when you need a deterministic scroll distance. Returns { swiped: true, timestampMs }. On a physical iOS device the result also carries reactivated: true when the target app was backgrounded and the runner had to re-front it for this swipe (the foreground screen changed as a side effect). Fails if the device backend is not reachable: the simulator-server for iOS simulators, the XCUITest runner for a physical iOS device, or the emulator backend for Android.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);

    if (isIosPhysicalDevice(device)) {
      return { iosDeviceRunner: iosDeviceRunnerRef(device) };
    }

    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const settle = params.settle ?? false;
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);

    if (isIosPhysicalDevice(device)) {
      // XCTest is one planned drag. settle holds at the destination. Release velocity is then zero.
      const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const viewport = await getViewport(runner, bundleId);

      const drag = await dragBetween(
        runner,
        bundleId,
        toPoints(viewport, params.fromX, params.fromY),
        toPoints(viewport, params.toX, params.toY),
        duration,
        settle
      );
      // Either leg can be the one that re-fronted a backgrounded target: the
      // viewport read fronts it first, so the drag then finds it foreground.
      const reactivated = viewport.reactivated === true || drag.reactivated;

      return {
        swiped: true,
        timestampMs,
        ...(reactivated ? { reactivated: true as const } : {}),
      };
    }

    const api = services.simulatorServer as SimulatorServerApi;
    const steps = Math.max(1, Math.round(duration / 16));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // `settle` lifts at ~0 velocity, so the OS applies no fling. Ease-out
      // beats a train of identical "hold" samples: those get coalesced away,
      // leaving the fast pre-hold velocity to fling, and a beyond-the-end hold
      // would run off-screen for a swipe that already finishes at an edge.
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

      if (i < steps) {
        await sleep(16);
      }
    }

    return { swiped: true, timestampMs };
  },
};
