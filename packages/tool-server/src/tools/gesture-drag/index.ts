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
      "Momentum-free drag: decelerate into the release point (ease-out) so an app deriving fling from pointer release velocity (carousels, drag libraries) reads ~0 and applies no momentum. Use when the drag must land exactly at the endpoint; default false (a constant-speed drag)."
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
  description: `Press the left mouse button at a start point, move to an end point, and release — a desktop mouse drag in a Chromium app. All positions are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Interpolates mouse-move events at ~60fps over durationMs for a natural drag.
Use for slider thumbs, drag-and-drop, text selection, or draggable UI elements. Dragging never scrolls content on desktop — use gesture-scroll for lists/pages. Chromium only — on iOS/Android use gesture-swipe.
Pass settle:true for a momentum-free drag that releases at ~0 pointer velocity, so apps that compute a fling from the pointer stream apply none and the drag lands exactly at the endpoint. Returns { dragged: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
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
    // Normalized 1.0 would land one past the last viewport pixel, where
    // Chromium delivers no pointerup — clamp both endpoints onto the
    // addressable range (interpolated moves between them stay in bounds).
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
    const steps = Math.max(2, Math.round(durationMs / 16));
    await chromium.dispatchMouseEvent({
      type: "mousePressed",
      x: startPx.x,
      y: startPx.y,
      clickCount: 1,
    });
    for (let i = 1; i < steps; i++) {
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
      await sleep(16);
    }
    await chromium.dispatchMouseEvent({
      type: "mouseReleased",
      x: endPx.x,
      y: endPx.y,
      clickCount: 1,
    });
    return { dragged: true, timestampMs };
  },
};
