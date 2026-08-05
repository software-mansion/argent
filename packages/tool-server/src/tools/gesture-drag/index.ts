import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ease-out exponent for a `settle` drag, mirroring gesture-swipe: the pointer
// follows 1-(1-t)^n so it decelerates into the release point and lifts at ~0
// velocity — app-level momentum on the web (Swiper, embla, framer-motion
// dragMomentum) is computed from this very pointer stream's release velocity.
const SETTLE_EASE_EXPONENT = 3;

// Sample floor for a `settle` drag: the ease-out only decelerates as finely as
// it is sampled, and the final frame before the release carries (1/steps)^3 of
// the travel — 12.5% at the 2 steps durationMs/16 leaves a 32ms drag, which
// releases mid-flight, versus ~0.2% at eight. Plain drags keep their frame-rate
// sampling; there the pointer is meant to be moving at the lift. Below ~70ms
// the eight frames no longer fit the duration at one CDP round-trip each, so
// such a drag overruns durationMs — the alternative is a settle that does
// nothing, and the flow swipe directive floors duration well above that.
const SETTLE_MIN_STEPS = 8;

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
    .optional()
    .describe("Total drag duration in milliseconds (default 300), interpolated at ~60fps."),
  settle: z
    .boolean()
    .optional()
    .describe(
      "Momentum-free drag: decelerate into the release point (ease-out) so an app deriving fling from pointer release velocity (carousels, drag libraries) reads ~0 and applies little to no momentum. Use when the drag must land exactly at the endpoint; default false (a constant-speed drag). Deceleration needs wall clock: under ~100ms the whole drag fits inside the velocity window a page averages over (tens of ms), so some fling survives, and under ~70ms its extra frames cannot dispatch fast enough to fit durationMs. Keep durationMs at its default when the fling must be fully suppressed."
    ),
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
  description: `Press the left mouse button at a start point, move to an end point, and release — a desktop mouse drag in a Chromium app. All positions are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Interpolates mouse-move events at ~60fps over durationMs for a natural drag (a settle drag samples more finely when durationMs is short, so its ease-out has a curve).
Use for slider thumbs, drag-and-drop, text selection, or draggable UI elements. Dragging never scrolls content on desktop — use gesture-scroll for lists/pages. Chromium only — on iOS/Android use gesture-swipe.
Pass settle:true for a momentum-free drag that decelerates into the release, so apps that compute a fling from the pointer stream read ~0 velocity and the drag lands exactly at the endpoint (a durationMs under ~100ms is too short for the deceleration to suppress the fling entirely). Returns { dragged: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "drag drop slider mouse press move release chromium select",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => ({
    chromium: chromiumCdpRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
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
    const settle = params.settle ?? false;
    const steps = Math.max(settle ? SETTLE_MIN_STEPS : 2, Math.round(durationMs / 16));
    const frameMs = durationMs / steps;
    // Pace every frame off one run-start deadline (t0 + i * frameMs) so each
    // dispatch round-trip (~8-10 ms) counts toward its own frame instead of
    // stacking on top of it, and the press→release span tracks durationMs at
    // every duration — apps threshold a flick against a drag on exactly this
    // number. Where frameMs falls under the round-trip the waits floor at 0 and
    // the span can only overrun; nothing dispatches faster than the CDP hop.
    const t0 = Date.now();
    await chromium.dispatchMouseEvent({
      type: "mousePressed",
      x: startPx.x,
      y: startPx.y,
      clickCount: 1,
    });
    for (let i = 1; i < steps; i++) {
      await sleep(Math.max(0, t0 + i * frameMs - Date.now()));
      const t = i / steps;
      // A plain drag advances linearly; a `settle` drag eases-out so the
      // per-frame step shrinks toward the release, giving pointer-velocity
      // momentum code nothing to fling with.
      const progress = settle ? 1 - Math.pow(1 - t, SETTLE_EASE_EXPONENT) : t;
      await chromium.dispatchMouseEvent({
        type: "mouseMoved",
        x: startPx.x + (endPx.x - startPx.x) * progress,
        y: startPx.y + (endPx.y - startPx.y) * progress,
        button: "left",
      });
    }
    // Spend the last frame's wait here, not on another move at the endpoint: a
    // point there followed by a still frame reads as a hold, and app momentum
    // code derives its fling from this stream's release velocity.
    await sleep(Math.max(0, t0 + durationMs - Date.now()));
    await chromium.dispatchMouseEvent({
      type: "mouseReleased",
      x: endPx.x,
      y: endPx.y,
      clickCount: 1,
    });
    return { dragged: true, timestampMs };
  },
};
