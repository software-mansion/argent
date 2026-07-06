import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A hidden window (minimized, fully occluded, or on another workspace) halts
 * the renderer's input pipeline: each wheel dispatch would stall until the CDP
 * call times out, and a chunked scroll dispatches dozens of them. Probe
 * `document.visibilityState` and refuse up front with a fix the caller can act
 * on. Only an explicit "hidden" refuses — a failed or empty read proves
 * nothing, and the scroll itself will surface a real transport error.
 */
async function assertWindowVisible(chromium: ChromiumCdpApi): Promise<void> {
  const raw = (await chromium.cdp.send("Runtime.evaluate", {
    expression: "document.visibilityState",
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (raw.result?.value === "hidden") {
    throw new FailureError(
      "Cannot scroll: the Chromium window is hidden (minimized or fully occluded), so the renderer will not process input events. Bring the window to the foreground and retry.",
      {
        error_code: FAILURE_CODES.CHROMIUM_INPUT_INVALID,
        failure_stage: "chromium_scroll_window_hidden",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe("Target Chromium device id from `list-devices` (chromium-cdp-<port>)."),
    x: z
      .number()
      .describe(
        "Anchor x: normalized 0.0–1.0 (fraction of window width, not pixels). The wheel events land here — put it over the element you want to scroll."
      ),
    y: z.number().describe("Anchor y: normalized 0.0–1.0 (fraction of window height, not pixels)."),
    deltaX: z
      .number()
      .optional()
      .describe(
        "Horizontal scroll distance as a fraction of the window width (e.g. 0.5 = half a window). Positive scrolls content right (reveals content to the right)."
      ),
    deltaY: z
      .number()
      .optional()
      .describe(
        "Vertical scroll distance as a fraction of the window height (e.g. 0.5 = half a window). Positive scrolls content down (reveals content below), like rolling a mouse wheel toward you."
      ),
    durationMs: z
      .number()
      .optional()
      .describe(
        "Spread the scroll over this many milliseconds in wheel-event steps (default 300) so scroll handlers fire progressively."
      ),
  })
  .refine((p) => (p.deltaX ?? 0) !== 0 || (p.deltaY ?? 0) !== 0, {
    message: "Pass a non-zero deltaX and/or deltaY — a scroll with no delta is a no-op.",
  });

type Params = z.infer<typeof zodSchema>;

interface Result {
  scrolled: boolean;
  timestampMs: number;
}

// Chromium only. Touch platforms scroll with `gesture-swipe`; a desktop
// renderer scrolls with wheel events, which is exactly what this dispatches.
// Keeping the two as separate tools (instead of overloading swipe) means each
// platform has one obvious scroll verb and the capability gate explains the
// other one.
const capability: ToolCapability = {
  chromium: { app: true },
};

export const gestureScrollTool: ToolDefinition<Params, Result> = {
  id: "gesture-scroll",
  description: `Scroll content in a Chromium app by dispatching mouse-wheel events at a point. Anchor x/y are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Deltas are fractions of the window too: deltaY 0.5 scrolls down half a window; negative scrolls back up.
Use when content is below/above the fold (describe shows off-screen elements with zero height) or a list needs scrolling. Chromium only — on iOS/Android use gesture-swipe.
Returns { scrolled: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "scroll wheel list page chromium mouse down up content fold",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => ({
    chromium: chromiumCdpRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const timestampMs = Date.now();
    const chromium = services.chromium as ChromiumCdpApi;
    await assertWindowVisible(chromium);
    const vp = chromium.getViewport();
    const totalDx = (params.deltaX ?? 0) * vp.width;
    const totalDy = (params.deltaY ?? 0) * vp.height;
    const durationMs = params.durationMs ?? 300;
    // Chunk into ~60fps wheel events so the renderer's scroll handlers fire
    // progressively, like a human rolling the wheel — one giant delta can
    // skip virtualized-list rendering and scroll-linked animations.
    const steps = Math.max(1, Math.round(durationMs / 16));
    const point = { x: params.x, y: params.y };
    for (let i = 0; i < steps; i++) {
      await chromium.server.sendWheel(point, totalDx / steps, totalDy / steps);
      if (i < steps - 1) await sleep(16);
    }
    return { scrolled: true, timestampMs };
  },
};
