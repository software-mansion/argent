import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";
import {
  describeVerify,
  runWithDeliveryVerification,
  type DeliveryCheck,
} from "../../utils/touch-verification";
import { sleep } from "../../utils/timing";

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
      "Momentum-free swipe: decelerate into the end point (ease-out) so the OS reads ~0 release velocity and applies little to no fling. Use for scroll-to-element loops; default false (a natural flinging swipe)."
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      describeVerify("swipe", {
        tail:
          "Frame-diff heuristic: a swipe on content already scrolled to its end can legitimately " +
          "change nothing.",
      })
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result extends DeliveryCheck {
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
Pass settle:true for a momentum-free swipe that lands exactly where the finger lifts (no fling), when you need a deterministic scroll distance. Returns { swiped: true, timestampMs }. The first touch per device session is automatically delivery-verified (a wedged iOS simulator can accept touches but silently drop them): when a check runs the result also carries 'verified' and, if the screen never changed, a 'warning' pointing at recover-touch-injection; verify:true forces the check, verify:false skips it. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const settle = params.settle ?? false;
    const timestampMs = Date.now();
    const api = services.simulatorServer as SimulatorServerApi;
    const steps = Math.max(1, Math.round(duration / 16));

    const injectSwipe = async () => {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // A plain swipe advances linearly; `settle` eases-out so the finger lifts
        // at ~0 velocity (no fling). Its decaying end-of-curve moves stay distinct
        // (UIKit coalesces identical "hold" samples, which would leave the pre-hold
        // velocity to fling) and every sample stays on-screen between the endpoints.
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
    };

    const check = await runWithDeliveryVerification(api, params.verify, injectSwipe);
    return { swiped: true, timestampMs, ...check };
  },
};
