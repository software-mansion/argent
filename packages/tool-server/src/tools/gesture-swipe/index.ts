import { z } from "zod";
import type { ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `settle` swipe: cubic glides fast then flattens over
// the final frames; a higher exponent would linger longer at rest.
const SETTLE_EASE_EXPONENT = 3;

const DEFAULT_DURATION_MS = 300;

// Wall clock a `settle` swipe needs to exist. Both OS velocity trackers fit a
// curve to the last frames before the lift, and that fit needs elapsed time to
// read a slowing finger as a stop. Given less it reads the ease-out as a flick
// and does not merely degrade but inverts: measured against a scrollable page,
// fromY 0.8 -> toY 0.2, a 24ms settle swipe flung an API 34 emulator's list all
// the way BACK to the top on every run, and iOS 26.5 forward 11624px against
// the same swipe's 7345px without `settle`. Still true at 50ms.
//
// Sample count is not the variable. Holding the wall clock at 24ms and sleeping
// sub-frame to add samples, 2, 9 and 16 samples all still reversed, while those
// same 9 samples across 144ms ran +421, +703, +412.
//
// The floor is a mitigation, not a cure: at 150ms Android medians 419px and iOS
// 368px against the plain swipe's 1773px / 2088px, but reversal only becomes
// rare, 2 of the 47 runs of the train 149ms and 150ms both emit against every
// run at 24ms. The quiet regime starts nearer 300ms (532-541px over 8 runs).
// Refused rather than floored to a step count the way Chromium's `gesture-drag`
// floors its own: there a floored frame no longer fits the duration anyway (one
// CDP round trip already overruns it), while here every frame is a real 16ms
// sleep, so a floor would quietly stretch a 16ms gesture to 150ms - and this is
// the raw tool flows point at precisely when durationMs has to mean what it says.
const SETTLE_MIN_DURATION_MS = 150;

// Ceiling on the travel time. Every frame below is a real 16ms sleep with the
// finger held down, so durationMs is wall clock the run spends AND wall clock
// the device spends under a touch it cannot shake off: durationMs 10000 costs
// 11.0s in process against a no-op transport, reproducible anywhere, and 11.2s
// end to end on a booted iPhone 17 Pro. And 1e21 - finite, positive, past
// every check that existed before this one - is 6.25e19 frames,
// a loop that outlives the client and goes on feeding the simulator until the
// tool-server is restarted, its samples interleaving into every later gesture
// sent to that device. The abort check in execute unwinds a CANCELLED run; a
// caller that simply waits needs this instead.
//
// 10s is the envelope the `rotate:` flow directive derives its own `by` limit
// from (MAX_DERIVED_ROTATE_MS), applied here to the same thing: one continuous
// finger-down-to-lift stroke. It is 626 frames, against the 300ms default and
// the 600ms `scroll-to` asks for, so the slowest deliberate stroke - a reorder
// handle dragged across a list, a pull-to-refresh held open - still fits with an
// order of magnitude to spare. It is deliberately NOT idle.stableFor's 600_000:
// that bounds a WAIT, which holds nothing down and cancels on a timer.
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
    settle: z
      .boolean()
      .optional()
      .describe(
        `Momentum-free swipe at the default durationMs: decelerate into the end point (ease-out) so the OS reads ~0 release velocity and applies little to no fling. Use for scroll-to-element loops; default false (a natural flinging swipe). Needs durationMs >= ${SETTLE_MIN_DURATION_MS} and is rejected below it: a shorter ease-out gives the OS velocity fit too little wall clock to read the deceleration as a stop, and it flings harder than a plain swipe instead (on Android, backwards). At ${SETTLE_MIN_DURATION_MS} itself the swipe lands short of where the finger stopped, and 2 of 47 runs still flung backwards.`
      ),
  })
  .refine((p) => !p.settle || (p.durationMs ?? DEFAULT_DURATION_MS) >= SETTLE_MIN_DURATION_MS, {
    message: `settle needs durationMs of at least ${SETTLE_MIN_DURATION_MS}: below that the ease-out has too little wall clock for the OS velocity fit to read it as a stop rather than a flick, so it flings harder than a plain swipe and, on Android, backwards. Raise durationMs, or drop settle for a plain flinging swipe at the duration you asked for.`,
    path: ["durationMs"],
  });

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
Pass settle:true for a momentum-free swipe that lands where the finger lifts (little to no fling at the 300 default), when you need a deterministic scroll distance; it needs durationMs >= 150 and is rejected below that, a shorter ease-out leaving the OS too little wall clock to read the deceleration as a stop. At 150 it lands short of the lift point instead, and 2 of 47 runs still flung backwards. A plain swipe takes any duration up to 10000ms and is delivered as close to the speed it was authored as a 16ms frame allows: below ~32ms the whole travel lands in one or two frames, which the OS flings as hard as it flings anything. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx?: ToolContext) {
    const duration = params.durationMs ?? DEFAULT_DURATION_MS;
    const settle = params.settle ?? false;
    const timestampMs = Date.now();
    const api = services.simulatorServer as SimulatorServerApi;
    // No sample floor on this ramp, unlike `settle` above: a fast swipe is
    // delivered as fast as it was authored, and that is faithful rather than
    // broken. At durationMs 16 the whole travel is one Move in one frame, the
    // hardest flick either OS can be handed, but what comes back tracks the
    // velocity asked for and saturates at the platform's own ceiling rather
    // than at anything invented here: measured on an API 34 emulator against a
    // scrollable page, a 16ms swipe settles 952px for a travel of 0.05 of the
    // screen, 3264px for 0.10, then 7452px for 0.30 and 7727px for 0.60 - the
    // last two the same saturated fling, apart by the 275px of extra finger
    // travel, Android clamping release velocity at its maximum (iOS 26.5 has no
    // such clamp and reaches 14343px for that 0.60). Flooring the count would
    // only turn durationMs into a lie; a caller who wants a smaller fling
    // authors a shorter travel or a longer duration.
    const steps = Math.max(1, Math.round(duration / 16));
    // Last dispatched sample, so an abort can lift from where the finger is.
    let lastX = 0;
    let lastY = 0;
    // Neither touch backend delivers the Up's coordinates: on both, the finger
    // lifts wherever the last Move landed. Measured on iOS 26.5 and an Android
    // emulator alike - a Down/Move/Up train whose Up jumped a further 0.2 of the
    // screen lifted at the Move's position, and a bare Down/Up pair 0.6 of a
    // screen apart scrolled nothing at all. So the end point has to be repeated
    // as a Move or the swipe is delivered short of where it was authored. How
    // short depends on the ramp below: a plain swipe stops a full step out, at
    // authored × (steps-1)/steps (5% at the default duration, 50% at
    // durationMs 32); a `settle` swipe's ease-out has already closed all but
    // (1/steps)^n of the travel — orders of magnitude nearer, but still not the
    // end point, so the repeat is unconditional rather than gated on `!settle`,
    // and settling is what `scroll-to` always asks for. The duplicate sample
    // does not damp the iOS fling, which is the reason it used to be withheld
    // there: the same default swipe settles a scrollable page 806px down with
    // the repeat against 803px without (n=14 each, run-to-run spread ~20px), so
    // any effect is well inside the noise.
    for (let i = 0; i <= steps; i++) {
      // Every frame below is a 16ms sleep, so without this a cancelled run keeps
      // driving the device for the rest of the duration - the client is gone and
      // the finger is still down, its samples interleaving into whatever gesture
      // is sent to that device next.
      if (ctx?.signal?.aborted) {
        // Once Down has been dispatched the synthetic finger is on the glass -
        // send a terminal Up so a cancelled run doesn't leave it held down.
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
      // `settle` lifts at ~0 velocity, so the OS applies no fling. Ease-out
      // beats a train of identical "hold" samples: those get coalesced away,
      // leaving the fast pre-hold velocity to fling, and a beyond-the-end hold
      // would run off-screen for a swipe that already finishes at an edge.
      const progress = settle ? 1 - Math.pow(1 - t, SETTLE_EASE_EXPONENT) : t;
      const x = params.fromX + (params.toX - params.fromX) * progress;
      const y = params.fromY + (params.toY - params.fromY) * progress;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      // Emitted in the Up's own frame, with no added sleep, so the total
      // duration and the move cadence are unchanged.
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
