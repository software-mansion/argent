import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long to hold the finger stationary (as a train of still Move samples) at
// the end of a `settle` swipe before lifting. Comfortably longer than iOS's
// ~100ms velocity-averaging window so the tracked velocity decays to ~0 and the
// scroll view skips its fling; short enough not to register as a long-press.
const SETTLE_DWELL_MS = 220;

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
      "Momentum-free swipe: dwell briefly at the end point before lifting so the OS reads ~0 release velocity and applies no fling. The content lands exactly where the finger stops, making the scroll distance deterministic. Use for scroll-to-element loops; default false (a natural flinging swipe)."
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
Pass settle:true for a momentum-free swipe that lands exactly where the finger lifts (no fling), when you need a deterministic scroll distance. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
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

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = params.fromX + (params.toX - params.fromX) * t;
      const y = params.fromY + (params.toY - params.fromY) * t;
      // When settling, the final keyframe stays a Move (the start of a stationary
      // hold at the end point) instead of the lift — the hold below decays the
      // tracked velocity to ~0 before we lift, so no fling.
      const type = i === 0 ? "Down" : i === steps && !settle ? "Up" : "Move";
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

    if (settle) {
      // Hold the finger stationary by emitting a *train* of zero-displacement
      // Move samples, not a single silent pause. iOS computes the lift velocity
      // from a weighted average of the most recent touch samples; one still
      // sample (or a gap with no events at all) leaves the fast pre-hold moves in
      // that average and the scroll view still flings. Feeding ~SETTLE_DWELL_MS
      // worth of still samples at ~60fps decays the average to ~0.
      const holdSamples = Math.max(4, Math.round(SETTLE_DWELL_MS / 16));
      for (let i = 0; i < holdSamples; i++) {
        await sleep(16);
        sendCommand(api, {
          cmd: "touch",
          type: "Move",
          x: params.toX,
          y: params.toY,
          second_x: null,
          second_y: null,
        });
      }
      sendCommand(api, {
        cmd: "touch",
        type: "Up",
        x: params.toX,
        y: params.toY,
        second_x: null,
        second_y: null,
      });
    }

    return { swiped: true, timestampMs };
  },
};
