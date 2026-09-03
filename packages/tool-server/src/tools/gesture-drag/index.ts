import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";

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

const zodSchema = z.object({
  udid: z.string().describe("Target Chromium device id from `list-devices` (chromium-cdp-<port>)."),
  fromX: z.number().describe("Press x: normalized 0.0–1.0 (fraction of window width, not pixels)."),
  fromY: z
    .number()
    .describe("Press y: normalized 0.0–1.0 (fraction of window height, not pixels)."),
  toX: z.number().describe("Release x: normalized 0.0–1.0 (not pixels; same space as tap)."),
  toY: z.number().describe("Release y: normalized 0.0–1.0 (not pixels; same space as tap)."),
  durationMs: z
    .number()
    .max(MAX_DURATION_MS, {
      message: `durationMs must be at most ${MAX_DURATION_MS} (10s): the drag holds the left button down for exactly this long, one frame per ~16ms, so a larger value is that much wall clock spent mid-press.`,
    })
    .optional()
    .describe(
      `Total drag duration in milliseconds (default 300, at most ${MAX_DURATION_MS} - the button stays down for exactly this long), interpolated at ~60fps.`
    ),
  momentum: z
    .boolean()
    .optional()
    .describe(
      "Whether the drag releases with momentum; default true (a constant-speed drag). Pass false to decelerate into the release point (ease-out) so an app deriving fling from pointer release velocity (carousels, drag libraries) reads ~0 and applies little to no momentum — use it when the drag must stop where it was aimed rather than fling past. Deceleration needs wall clock: under ~100ms the whole drag fits inside the velocity window a page averages over (tens of ms), so some fling survives, and under ~70ms its extra frames cannot dispatch fast enough to fit durationMs. Keep durationMs at its default when the fling must be fully suppressed."
    ),
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

interface Result {
  dragged: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  chromium: { app: true },
};

export const gestureDragTool: ToolDefinition<Params, Result> = {
  id: "gesture-drag",
  interaction: {
    startedMsg: ({ params }) =>
      `Dragging from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    completedMsg: ({ params }) =>
      `Dragged from (${Math.round(params.fromX * 100)}%, ${Math.round(params.fromY * 100)}%) to (${Math.round(params.toX * 100)}%, ${Math.round(params.toY * 100)}%)`,
    failedMsg: ({ failureSignal }) => `Failed to drag: ${failureSignal.error_code}`,
  },
  description: `Press the left mouse button at a start point, move to an end point, and release — a desktop mouse drag in a Chromium app. All positions are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe, except that a coordinate of exactly 1.0 lands one pixel inside the window edge (gesture-tap maps it to the edge itself). Interpolates mouse-move events at ~60fps over durationMs for a natural drag (a momentum-free drag samples more finely when durationMs is short, so its ease-out has a curve).
Use for slider thumbs, drag-and-drop, text selection, or draggable UI elements. Dragging never scrolls content on desktop — use gesture-scroll for lists/pages. Chromium only — on iOS/Android use gesture-swipe.
Pass momentum:false for a momentum-free drag that decelerates into the release, so apps that compute a fling from the pointer stream read ~0 velocity and the drag ends where it was aimed instead of flinging past it (a durationMs under ~100ms is too short for the deceleration to suppress the fling entirely). Returns { dragged: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "drag drop slider mouse press move release chromium select",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => ({
    chromium: chromiumCdpRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx?: ToolContext) {
    const timestampMs = Date.now();
    const chromium = services.chromium as ChromiumCdpApi;
    // A drag's ~60fps mouse moves each wait on compositor hit-testing, which a
    // hidden window services at ~5s per event — minutes per drag.
    await assertChromiumWindowVisible(chromium, "drag", "chromium_drag_window_hidden");
    const vp = chromium.getViewport();
    // Normalized 1.0 maps one past the last addressable pixel, where a release
    // was observed delivering pointerdown and moves but no pointerup. Clamping
    // costs one pixel at the edge and diverges from gesture-tap, which maps 1.0
    // to size; re-test the release before aligning the two.
    const clampPx = (px: number, size: number) => Math.min(Math.max(px, 0), size - 1);
    const startPx = {
      x: clampPx(params.fromX * vp.width, vp.width),
      y: clampPx(params.fromY * vp.height, vp.height),
    };
    const endPx = {
      x: clampPx(params.toX * vp.width, vp.width),
      y: clampPx(params.toY * vp.height, vp.height),
    };
    const durationMs = params.durationMs ?? 300;
    const momentumFree = params.momentum === false;
    const steps = Math.max(momentumFree ? MOMENTUM_FREE_MIN_STEPS : 2, Math.round(durationMs / 16));
    const frameMs = durationMs / steps;
    // Pace every frame off one run-start deadline so each dispatch round-trip
    // (~8-10ms) counts toward its own frame and the press→release span tracks
    // durationMs - apps threshold a flick against a drag on exactly that number.
    const t0 = Date.now();
    // Last dispatched position, so an abort releases where the pointer is.
    let lastX = startPx.x;
    let lastY = startPx.y;
    // The button is down for the whole span, so check the abort once per frame.
    const abortError = (frame: number): Error => {
      const err = new Error(
        `gesture-drag aborted - cancelled mid-drag after ${frame} of ${steps + 1} frames`
      );
      err.name = "AbortError";
      return err;
    };
    // Release where the pointer is: the delivered press would otherwise capture
    // every later click, and releasing at the end point delivers travel the caller
    // cancelled. Best effort - a cancel is when the CDP session can be going away
    // - so a failed release rides along as the AbortError's `cause` rather than
    // replacing it.
    const releaseAndAbort = async (frame: number): Promise<never> => {
      const err = abortError(frame);
      try {
        await chromium.dispatchMouseEvent({
          type: "mouseReleased",
          x: lastX,
          y: lastY,
          clickCount: 1,
        });
      } catch (releaseErr) {
        err.cause = releaseErr;
      }
      throw err;
    };
    // Nothing is pressed yet, so this one only declines.
    if (ctx?.signal?.aborted) throw abortError(0);
    await chromium.dispatchMouseEvent({
      type: "mousePressed",
      x: startPx.x,
      y: startPx.y,
      clickCount: 1,
    });
    for (let i = 1; i < steps; i++) {
      if (ctx?.signal?.aborted) await releaseAndAbort(i);
      await sleep(Math.max(0, t0 + i * frameMs - Date.now()));
      const t = i / steps;
      const progress = momentumFree ? 1 - Math.pow(1 - t, MOMENTUM_FREE_EASE_EXPONENT) : t;
      const x = startPx.x + (endPx.x - startPx.x) * progress;
      const y = startPx.y + (endPx.y - startPx.y) * progress;
      await chromium.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "left" });
      lastX = x;
      lastY = y;
    }
    // The loop stops one short of the release, so the last frame is checked on
    // both sides of its wait: before, to skip the wait; after, to catch an abort
    // landing during it. Both report `steps` - a wait delivers no pointer events.
    if (ctx?.signal?.aborted) await releaseAndAbort(steps);
    // Spend the last frame's wait here rather than on another move at the
    // endpoint: a move followed by a still frame reads as a hold.
    await sleep(Math.max(0, t0 + durationMs - Date.now()));
    if (ctx?.signal?.aborted) await releaseAndAbort(steps);
    await chromium.dispatchMouseEvent({
      type: "mouseReleased",
      x: endPx.x,
      y: endPx.y,
      clickCount: 1,
    });
    return { dragged: true, timestampMs };
  },
};
