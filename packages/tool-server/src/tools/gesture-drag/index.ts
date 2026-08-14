import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `momentum: false` drag, mirroring gesture-swipe: the
// pointer follows 1-(1-t)^n so it decelerates into the release point and lifts
// at ~0 velocity — app-level momentum on the web (Swiper, embla, framer-motion
// dragMomentum) is computed from this very pointer stream's release velocity.
const MOMENTUM_FREE_EASE_EXPONENT = 3;

// Sample floor for a momentum-free drag: the ease-out only decelerates as finely
// as it is sampled, and the final frame before the release carries (1/steps)^3
// of the travel — 12.5% at the 2 steps durationMs/16 leaves a 32ms drag, which
// releases mid-flight, versus ~0.2% at eight. Plain drags keep their frame-rate
// sampling; there the pointer is meant to be moving at the lift. Below ~70ms
// the eight frames no longer fit the duration at one CDP round-trip each, so
// such a drag overruns durationMs — the alternative is an ease-out that does
// nothing, and the flow swipe directive floors duration well above that.
const MOMENTUM_FREE_MIN_STEPS = 8;

// Ceiling on the drag time, the same one gesture-swipe carries and for the same
// reason: durationMs is wall clock the run spends with the left button held
// down, paced one frame per ~16ms, so an unbounded value is an unbounded press.
// A drag is worse off than a swipe here - the button stays down across a hidden
// window, a navigation, a tab close - and it is one continuous pointer stroke,
// which is what the 10s envelope bounds (MAX_DERIVED_ROTATE_MS, whose own
// gesture limit derives from it). 10s against a 300ms default leaves any real
// slider drag or drag-and-drop an order of magnitude of headroom.
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
  // `settle` was `momentum`'s earlier spelling, with the opposite polarity.
  // Unlike the swipe's it never reached a release - only this stack's builds -
  // but a recording or caller from those builds still carries it, and this
  // non-strict object would strip it and run the flinging default.
  settle: z
    .never({
      error:
        "gesture-drag's `settle` was renamed to `momentum`, with the opposite sense - write `momentum: false` for the momentum-free drag that `settle: true` used to mean (plain `settle: false` was the default, so just drop it)",
    })
    .optional()
    .describe("Retired: renamed to `momentum` with the opposite sense. Pass `momentum: false`."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  dragged: boolean;
  timestampMs: number;
}

// Chromium only. Touch platforms express a drag through gesture-swipe's
// touch sequence; on a desktop renderer the equivalent is a left-button
// mouse drag. Note a desktop drag never scrolls content — that's
// gesture-scroll's job — it moves things: slider thumbs, drag-and-drop
// payloads, text selections, window-content widgets.
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
    // A drag interpolates ~60fps mouse moves; on a hidden (throttled) window
    // each one stalls on compositor hit-testing (~5s), turning one drag into
    // minutes of wall clock — refuse up front like gesture-scroll.
    await assertChromiumWindowVisible(chromium, "drag", "chromium_drag_window_hidden");
    const vp = chromium.getViewport();
    // Normalized 1.0 maps to pixel == viewport size, one past the last
    // addressable pixel; a drag released there was observed delivering
    // pointerdown and moves but never a pointerup — routine for flow swipes
    // whose `by` deltas saturate to 1 — so clamp both endpoints onto the
    // addressable range (interpolated moves between them stay in bounds).
    // Read that as build-specific rather than a universal Chromium rule: an
    // E2E review measured an unclamped release at width, and at 2 * width,
    // arriving in full. The clamp stays because a silently missing pointerup
    // is a far worse failure than what it costs — one pixel at the extreme
    // edge, and a deliberate divergence from gesture-tap, which maps 1.0 to
    // size. Don't align the two without re-testing the release first.
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
    // Pace every frame off one run-start deadline (t0 + i * frameMs) so each
    // dispatch round-trip (~8-10 ms) counts toward its own frame instead of
    // stacking on top of it, and the press→release span tracks durationMs at
    // every duration — apps threshold a flick against a drag on exactly this
    // number. Where frameMs falls under the round-trip the waits floor at 0 and
    // the span can only overrun; nothing dispatches faster than the CDP hop.
    const t0 = Date.now();
    // Last dispatched pointer position, so an abort can release from where the
    // pointer is.
    let lastX = startPx.x;
    let lastY = startPx.y;
    // The whole press→release span holds a button down, so an abort is checked
    // once per frame, as gesture-rotate checks its own: the deadline pacing above
    // only moves where each wait sits, it does not change that a cancelled run
    // must stop driving the page.
    const abortError = (frame: number): Error => {
      const err = new Error(
        `gesture-drag aborted - cancelled mid-drag after ${frame} of ${steps + 1} frames`
      );
      err.name = "AbortError";
      return err;
    };
    // The button is down by the time this runs, so release it where the pointer
    // is: the press already delivered would otherwise capture every later click,
    // and releasing at the end point would deliver the travel the caller
    // cancelled. That release is best effort - a cancel is exactly when the CDP
    // session can be going away, and a rejected dispatch leaves no transport to
    // lift the button through. The AbortError is not: it is thrown either way,
    // carrying the failed release as its `cause`. Nothing downstream reads
    // err.name for this tool, so the message is the only part of the error that
    // says cancel; letting the transport error stand in loses it, and makes this
    // the one gesture whose cancel does not read as one - both siblings abort
    // unconditionally, their terminal Up being a non-awaited, non-throwing send.
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
      // A plain drag advances linearly; a momentum-free one eases-out so the
      // per-frame step shrinks toward the release, giving pointer-velocity
      // momentum code nothing to fling with.
      const progress = momentumFree ? 1 - Math.pow(1 - t, MOMENTUM_FREE_EASE_EXPONENT) : t;
      const x = startPx.x + (endPx.x - startPx.x) * progress;
      const y = startPx.y + (endPx.y - startPx.y) * progress;
      await chromium.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "left" });
      lastX = x;
      lastY = y;
    }
    // The loop stops one short of the release, so the final frame is checked
    // out here instead - once on each side of its wait. The first declines to
    // spend that wait at all when the abort has already landed; the second
    // catches one landing during it, which would otherwise deliver the endpoint
    // the caller cancelled and return { dragged: true } on an aborted signal.
    // Both report `steps`, because the number counts pointer events delivered
    // and a wait delivers none. gesture-swipe covers the same frame from inside
    // its `i <= steps` loop, which sleeps at the bottom and checks at the top,
    // so the iteration sending its terminal Up spans the preceding wait.
    if (ctx?.signal?.aborted) await releaseAndAbort(steps);
    // Spend the last frame's wait here, not on another move at the endpoint: a
    // point there followed by a still frame reads as a hold, and app momentum
    // code derives its fling from this stream's release velocity.
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
