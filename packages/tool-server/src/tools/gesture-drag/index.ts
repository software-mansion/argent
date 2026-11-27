import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";
import {
  MACOS_CLICK_SETTLE_MS,
  macosAppServices,
  macosMouse,
  requireMacosApp,
} from "../../utils/macos-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `momentum: false` drag, mirroring gesture-swipe: the
// pointer follows 1-(1-t)^n, so it lifts at ~0 velocity and app fling code reads
// no momentum.
const MOMENTUM_FREE_EASE_EXPONENT = 3;

// Sample floor for a momentum-free drag: the last frame carries (1/steps)^3 of
// the travel, so the 2 steps durationMs/16 leaves a 32ms drag release mid-flight
// at 12.5%, versus ~0.2% at eight. Below ~70ms those frames no longer fit one
// CDP round-trip each and the drag overruns durationMs.
const MOMENTUM_FREE_MIN_STEPS = 8;

// durationMs is wall clock spent with the button held down, so it needs a
// ceiling. The same 10s gesture-swipe carries, an order of magnitude above the
// 300ms default.
const MAX_DURATION_MS = 10_000;
// A long press on a Mac app holds as long as the e2e long-press directive: SwiftUI and
// React Native fire theirs after 500 ms.
const MACOS_LONG_PRESS_MS = 800;

interface Result {
  dragged: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  chromium: { app: true },
  macos: { app: true, catalyst: true },
};

type Point = { x: number; y: number };

/**
 * A left-button drag from `from` to `to` in the caller's coordinates: down,
 * moves at ~60fps over `durationMs`, up.
 */
async function runPointerDrag(
  from: Point,
  to: Point,
  opts: { durationMs?: number; momentum?: boolean; signal?: AbortSignal; paceFromPress?: boolean },
  pointer: Record<"down" | "move" | "up", (point: Point) => Promise<void>>
): Promise<void> {
  const durationMs = opts.durationMs ?? 300;
  const momentumFree = opts.momentum === false;
  const steps = Math.max(momentumFree ? MOMENTUM_FREE_MIN_STEPS : 2, Math.round(durationMs / 16));
  const frameMs = durationMs / steps;
  // Pace every frame off one run-start deadline so each dispatch round-trip
  // (~8-10ms) counts toward its own frame and the press→release span tracks
  // durationMs - apps threshold a flick against a drag on exactly that number.
  let t0 = Date.now();
  // Last dispatched position, so an abort releases where the pointer is.
  let last = from;
  // The button is down for the whole span, so check the abort once per frame.
  const abortError = (frame: number): Error => {
    const err = new Error(
      `gesture-drag aborted - cancelled mid-drag after ${frame} of ${steps + 1} frames`
    );
    err.name = "AbortError";
    return err;
  };
  // Marks the button up before dispatching, so a release that rejects is not
  // retried by the recovery path below.
  let buttonDown: boolean;
  const release = async (point: Point): Promise<void> => {
    buttonDown = false;
    await pointer.up(point);
  };
  // Release where the pointer is: the delivered press would otherwise capture
  // every later click, and releasing at the end point delivers travel the caller
  // cancelled. Best effort - a cancel is when the session can be going away -
  // so a failed release rides along as the AbortError's `cause` rather than
  // replacing it.
  const releaseAndAbort = async (frame: number): Promise<never> => {
    const err = abortError(frame);
    try {
      await release(last);
    } catch (releaseErr) {
      err.cause = releaseErr;
    }
    throw err;
  };
  // Nothing is pressed yet, so this one only declines.
  if (opts.signal?.aborted) throw abortError(0);
  await pointer.down(from);
  buttonDown = true;
  if (opts.paceFromPress) t0 = Date.now();
  try {
    for (let i = 1; i < steps; i++) {
      if (opts.signal?.aborted) await releaseAndAbort(i);
      await sleep(Math.max(0, t0 + i * frameMs - Date.now()));
      const t = i / steps;
      const progress = momentumFree ? 1 - Math.pow(1 - t, MOMENTUM_FREE_EASE_EXPONENT) : t;
      const point = {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
      };
      await pointer.move(point);
      last = point;
    }
    // The loop stops one short of the release, so the last frame is checked on
    // both sides of its wait: before, to skip the wait; after, to catch an abort
    // landing during it. Both report `steps` - a wait delivers no pointer events.
    if (opts.signal?.aborted) await releaseAndAbort(steps);
    // Spend the last frame's wait here rather than on another move at the
    // endpoint: a move followed by a still frame reads as a hold.
    await sleep(Math.max(0, t0 + durationMs - Date.now()));
    if (opts.signal?.aborted) await releaseAndAbort(steps);
    await release(to);
  } catch (err) {
    // A mid-drag dispatch that rejects leaves the app holding the button - a
    // session survives a timed-out send - and every later click is then read
    // as a drag. Best effort, and the caller keeps seeing the original failure.
    if (buttonDown) await release(last).catch(() => {});
    throw err;
  }
}

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Chromium device id (`chromium-cdp-<port>`)<flag:macos-apps> or Mac app id</flag:macos-apps> from `list-devices`."
    ),
  fromX: z.number().min(0).max(1).describe("Start x."),
  fromY: z.number().min(0).max(1).describe("Start y."),
  toX: z.number().min(0).max(1).describe("End x."),
  toY: z.number().min(0).max(1).describe("End y."),
  durationMs: z
    .number()
    .max(MAX_DURATION_MS, {
      message: `durationMs must be at most ${MAX_DURATION_MS} (10s): the drag holds the left button down for exactly this long, one frame per ~16ms, so a larger value is that much wall clock spent mid-press.`,
    })
    .optional()
    .describe(
      "Drag duration in ms (default 300<flag:macos-apps>; 800 for a Mac app long press</flag:macos-apps>)."
    ),
  momentum: z
    .boolean()
    .optional()
    .describe("Default true (constant speed). false decelerates into release to avoid fling."),
  // `momentum`'s earlier spelling, with the opposite polarity. Declared so this
  // non-strict object refuses it instead of stripping it and running the default.
  settle: z
    .never({
      error:
        "gesture-drag's `settle` was renamed to `momentum`, with the opposite sense - write `momentum: false` for the momentum-free drag that `settle: true` used to mean (plain `settle: false` was the default, so just drop it)",
    })
    .optional()
    .describe(
      "Retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const gestureDragTool: ToolDefinition<Params, Result> = {
  id: "gesture-drag",
  description: `Drag the left mouse button between normalized [0,1] window points in Chromium<flag:macos-apps> or a Mac app</flag:macos-apps>.
Use when dragging sliders, drag-and-drop items, or selecting text (use \`gesture-scroll\` to scroll desktop lists; use \`gesture-swipe\` on iOS/Android<flag:harmonyos>/HarmonyOS</flag:harmonyos>).<flag:macos-apps> Mac app: same start/end point = long press; drops stay inside the app's windows.</flag:macos-apps>
Returns \`{ dragged: true, timestampMs }\`. Fails if the CDP session is unreachable.`,
  zodSchema,
  searchHint:
    "drag drop slider mouse press move release chromium<flag:macos-apps> mac</flag:macos-apps> select",
  interaction: {
    startedMsg: ({ params }) =>
      `Dragging from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Dragged from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to drag: ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "macos") return macosAppServices(device);
    return { chromium: chromiumCdpRef(device) };
  },
  async execute(services, params, ctx?: ToolContext) {
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);
    const opts = { durationMs: params.durationMs, momentum: params.momentum, signal: ctx?.signal };
    if (device.platform === "macos") {
      const app = requireMacosApp(services, "gesture-drag", device);
      const longPress = params.fromX === params.toX && params.fromY === params.toY;
      let at: Point = { x: params.fromX, y: params.fromY };
      await runPointerDrag(
        at,
        { x: params.toX, y: params.toY },
        {
          ...opts,
          durationMs: params.durationMs ?? (longPress ? MACOS_LONG_PRESS_MS : undefined),
          // An app's first press after launch answers hundreds of ms late, which a hold must not lose.
          paceFromPress: longPress,
        },
        {
          down: (p) => macosMouse(app, { type: "down", ...p, clickCount: 1 }),
          move: async (p) => {
            // A resting mouse sends no dragged events, and a drag event cancels some apps' hold.
            if (longPress) return;
            await macosMouse(app, { type: "move", ...p });
            at = p;
          },
          // Web pages and custom views follow the moves, not the release: the last move is at
          // the release point. A move that fails must not keep the up from the app.
          up: async (p) => {
            try {
              if (p.x !== at.x || p.y !== at.y) await macosMouse(app, { type: "move", ...p });
            } finally {
              await macosMouse(app, { type: "up", ...p, clickCount: 1 });
            }
          },
        }
      );
      await sleep(MACOS_CLICK_SETTLE_MS);
      return { dragged: true, timestampMs };
    }
    const chromium = services.chromium as ChromiumCdpApi;
    // A drag's ~60fps mouse moves each wait on compositor hit-testing, which a
    // hidden window services at ~5s per event — minutes per drag.
    await assertChromiumWindowVisible(chromium, "drag");
    const vp = chromium.getViewport();
    // Normalized 1.0 maps one past the last addressable pixel, where a release
    // was observed delivering pointerdown and moves but no pointerup. Clamping
    // costs one pixel at the edge and diverges from gesture-tap, which maps 1.0
    // to size; re-test the release before aligning the two.
    const clampPx = (px: number, size: number) => Math.min(Math.max(px, 0), size - 1);
    const toPx = (x: number, y: number): Point => ({
      x: clampPx(x * vp.width, vp.width),
      y: clampPx(y * vp.height, vp.height),
    });
    await runPointerDrag(toPx(params.fromX, params.fromY), toPx(params.toX, params.toY), opts, {
      down: (p) => chromium.dispatchMouseEvent({ type: "mousePressed", ...p, clickCount: 1 }),
      move: (p) => chromium.dispatchMouseEvent({ type: "mouseMoved", ...p, button: "left" }),
      up: (p) => chromium.dispatchMouseEvent({ type: "mouseReleased", ...p, clickCount: 1 }),
    });
    return { dragged: true, timestampMs };
  },
};
