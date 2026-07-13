import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { coreDeviceRef, type CoreDeviceApi } from "../../blueprints/core-device";
import { resolveDevice, isPhysicalIos } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `settle` swipe. The finger follows 1-(1-t)^n rather
// than a straight line, so it decelerates into the end point and lifts at ~0
// velocity — the scroll view then skips its fling. Cubic gives a fast glide that
// flattens over the final frames; a higher exponent would linger longer at rest.
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
      "Momentum-free swipe: decelerate into the end point (ease-out) so the OS reads ~0 release velocity and applies little to no fling. Use for scroll-to-element loops; default false (a natural flinging swipe). Simulator/emulator only — rejected on a physical iPhone."
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
};

export const gestureSwipeTool: ToolDefinition<Params, Result> = {
  id: "gesture-swipe",
  description: `Execute a smooth swipe / drag touch gesture between two points on the device (iOS simulator or Android emulator). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Not supported on Chromium — use gesture-scroll there instead.
Pass settle:true for a momentum-free swipe that lands exactly where the finger lifts (no fling), when you need a deterministic scroll distance. Returns { swiped: true, timestampMs }. On a physical iPhone, swipes route over CoreDevice, which drives a fixed linear HID drag — settle is not available there. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (isPhysicalIos(device)) {
      // A settling swipe is rejected in execute(); resolving CoreDevice here
      // would pay for tunnel setup — possibly a macOS admin prompt — just to
      // reject afterwards (same reasoning as `button` with no HID equivalent).
      if (params.settle) return {};
      return { coreDevice: coreDeviceRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const settle = params.settle ?? false;
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);
    if (isPhysicalIos(device)) {
      // CoreDevice drives the swipe as a single pymobiledevice3 HID drag whose
      // trajectory is a fixed linear interpolation over (steps, duration) — the
      // per-sample easing that makes `settle` momentum-free cannot be expressed
      // through it. Silently ignoring the flag would hand back a flinging swipe
      // while claiming a deterministic scroll distance, so reject it instead.
      if (settle) {
        throw new UnsupportedOperationError(
          "gesture-swipe",
          device,
          "settle:true is not available on physical iOS (the CoreDevice HID drag has a fixed linear trajectory, so the swipe always releases with fling velocity). Re-issue without settle, or use a shorter swipe to bound the fling."
        );
      }
      const coreDevice = services.coreDevice as CoreDeviceApi;
      await coreDevice.swipe(params.fromX, params.fromY, params.toX, params.toY, duration);
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
