import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  description: `Press the left mouse button at a start point, move to an end point, and release — a desktop mouse drag in a Chromium app. All positions are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Interpolates mouse-move events at ~60fps over durationMs for a natural drag.
Use for slider thumbs, drag-and-drop, text selection, or draggable UI elements. Dragging never scrolls content on desktop — use gesture-scroll for lists/pages. Chromium only — on iOS/Android use gesture-swipe.
Returns { dragged: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
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
    const vp = chromium.getViewport();
    const startPx = { x: params.fromX * vp.width, y: params.fromY * vp.height };
    const endPx = { x: params.toX * vp.width, y: params.toY * vp.height };
    const durationMs = params.durationMs ?? 300;
    const steps = Math.max(2, Math.round(durationMs / 16));
    await chromium.dispatchMouseEvent({
      type: "mousePressed",
      x: startPx.x,
      y: startPx.y,
      clickCount: 1,
    });
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      await chromium.dispatchMouseEvent({
        type: "mouseMoved",
        x: startPx.x + (endPx.x - startPx.x) * t,
        y: startPx.y + (endPx.y - startPx.y) * t,
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
