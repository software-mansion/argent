import { z } from "zod";
import type { ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `momentum: false` swipe: cubic glides fast then
// flattens over the final frames; a higher exponent would linger longer at rest.
const MOMENTUM_FREE_EASE_EXPONENT = 3;

const DEFAULT_DURATION_MS = 300;

// Wall clock a `momentum: false` swipe needs. Both OS velocity trackers fit a
// curve to the last frames before the lift; given less elapsed time they read
// the ease-out as a flick and fling harder than a plain swipe - on Android,
// backwards. 150ms only makes that rare (2 of 47 runs); the quiet regime starts
// nearer 300ms. Refused rather than floored the way `gesture-drag` floors its
// step count, because every frame here is a real 16ms sleep and a floor would
// quietly stretch a 16ms gesture to 150ms.
const MOMENTUM_FREE_MIN_DURATION_MS = 150;

// Ceiling on the travel time. Every frame below is a real 16ms sleep with the
// finger held down, so durationMs is wall clock both the run and the device
// spend under a touch neither can shake off - and 1e21, finite and positive, is
// a loop that outlives the client and feeds the simulator until the tool-server
// restarts. 10s is the envelope `rotate:` derives MAX_DERIVED_ROTATE_MS from,
// applied to the same thing: one finger-down-to-lift stroke.
const MAX_DURATION_MS = 10_000;

const zodSchema = z
  .object({
    udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
    fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
    fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
    toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
    toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
    durationMs: z
      .number()
      .max(MAX_DURATION_MS, {
        message: `durationMs must be at most ${MAX_DURATION_MS} (10s): every frame is a real 16ms sleep with the finger held down, so a larger value is that many milliseconds of wall clock spent holding a touch the device cannot shake off.`,
      })
      .optional()
      .describe(
        `Total gesture duration in milliseconds (default 300, at most ${MAX_DURATION_MS} - the gesture holds a finger down for exactly this long)`
      ),
    momentum: z
      .boolean()
      .optional()
      .describe(
        `Whether the swipe releases with momentum; default true (a natural flinging swipe). Pass false for a momentum-free swipe at the default durationMs: the finger decelerates into the end point (ease-out) so the OS reads ~0 release velocity and applies little to no fling. Use false for scroll-to-element loops. momentum: false needs durationMs >= ${MOMENTUM_FREE_MIN_DURATION_MS} and is rejected below it: a shorter ease-out gives the OS velocity fit too little wall clock to read the deceleration as a stop, and it flings harder than a plain swipe instead (on Android, backwards). At ${MOMENTUM_FREE_MIN_DURATION_MS} itself the swipe lands short of where the finger stopped, and 2 of 47 runs still flung backwards.`
      ),
    // `momentum`'s shipped spelling, with the opposite polarity. Declared so this
    // non-strict object refuses it instead of stripping it and flinging - the exact
    // inverse of the gesture the caller asked for.
    settle: z
      .never({
        error:
          "gesture-swipe's `settle` was renamed to `momentum`, with the opposite sense — write `momentum: false` for the momentum-free swipe that `settle: true` used to mean (plain `settle: false` was the default, so just drop it)",
      })
      .optional()
      .describe(
        "Retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key."
      ),
  })
  .refine(
    (p) =>
      p.momentum !== false ||
      (p.durationMs ?? DEFAULT_DURATION_MS) >= MOMENTUM_FREE_MIN_DURATION_MS,
    {
      message: `momentum: false needs durationMs of at least ${MOMENTUM_FREE_MIN_DURATION_MS}: below that the ease-out has too little wall clock for the OS velocity fit to read it as a stop rather than a flick, so it flings harder than a plain swipe and, on Android, backwards. Raise durationMs, or drop momentum: false for a plain flinging swipe at the duration you asked for.`,
      path: ["durationMs"],
    }
  );

type Params = z.infer<typeof zodSchema>;

interface Result {
  swiped: boolean;
  timestampMs: number;
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
  // The bounds are spelled out rather than interpolated: extract-tools scans this
  // description statically, so a `${}` in it drops the tool out of the scan.
  description: `Execute a smooth swipe / drag touch gesture between two points on the device (iOS simulator or Android emulator). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Not supported on Chromium — use gesture-scroll there instead.
Pass momentum:false for a momentum-free swipe that lands where the finger lifts (little to no fling at the 300 default), when you need a deterministic scroll distance; it needs durationMs >= 150 and is rejected below that, a shorter ease-out leaving the OS too little wall clock to read the deceleration as a stop. At 150 it lands short of the lift point instead, and 2 of 47 runs still flung backwards. A plain swipe takes any duration up to 10000ms and is delivered as close to the speed it was authored as a 16ms frame allows: below ~32ms the whole travel lands in one or two frames, which the OS flings as hard as it flings anything. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx?: ToolContext) {
    const duration = params.durationMs ?? DEFAULT_DURATION_MS;
    const momentumFree = params.momentum === false;
    const timestampMs = Date.now();
    const api = services.simulatorServer as SimulatorServerApi;
    // No sample floor on this ramp, unlike `momentum: false` above: a fast swipe
    // is delivered as fast as it was authored. At durationMs 16 the whole travel
    // is one Move, the hardest flick either OS can be handed, but the fling
    // saturates at the platform's own ceiling rather than at anything invented
    // here. Flooring the count would only turn durationMs into a lie.
    const steps = Math.max(1, Math.round(duration / 16));
    // Last dispatched sample, so an abort can lift from where the finger is.
    let lastX = 0;
    let lastY = 0;
    // Neither touch backend delivers the Up's coordinates: on both, the finger
    // lifts wherever the last Move landed. So the end point has to be repeated as
    // a Move or the swipe lands short of where it was authored - a full step out
    // for a plain swipe (50% at durationMs 32), (1/steps)^n for a momentum-free
    // one. Unconditional, because the duplicate sample does not damp the iOS
    // fling it used to be withheld for (806px with against 803px without, n=14).
    for (let i = 0; i <= steps; i++) {
      // Every frame below is a 16ms sleep, so without this a cancelled run keeps
      // driving the device for the rest of the duration, its samples interleaving
      // into whatever gesture is sent to that device next.
      if (ctx?.signal?.aborted) {
        // Down has already landed, so lift the finger before unwinding.
        if (i > 0) {
          sendCommand(api, {
            cmd: "touch",
            type: "Up",
            x: lastX,
            y: lastY,
            second_x: null,
            second_y: null,
          });
        }
        const err = new Error(
          `gesture-swipe aborted - cancelled mid-gesture after ${i} of ${steps + 1} frames`
        );
        err.name = "AbortError";
        throw err;
      }

      const t = i / steps;
      // A momentum-free swipe lifts at ~0 velocity, so the OS applies no fling.
      // Ease-out beats a train of identical "hold" samples: those get coalesced
      // away, leaving the fast pre-hold velocity to fling, and a beyond-the-end
      // hold would run off-screen for a swipe that already finishes at an edge.
      const progress = momentumFree ? 1 - Math.pow(1 - t, MOMENTUM_FREE_EASE_EXPONENT) : t;
      const x = params.fromX + (params.toX - params.fromX) * progress;
      const y = params.fromY + (params.toY - params.fromY) * progress;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      // In the Up's own frame, with no added sleep, so the cadence is unchanged.
      if (type === "Up") {
        sendCommand(api, {
          cmd: "touch",
          type: "Move",
          x,
          y,
          second_x: null,
          second_y: null,
        });
      }
      sendCommand(api, {
        cmd: "touch",
        type,
        x,
        y,
        second_x: null,
        second_y: null,
      });
      lastX = x;
      lastY = y;
      if (i < steps) await sleep(16);
    }

    return { swiped: true, timestampMs };
  },
};
