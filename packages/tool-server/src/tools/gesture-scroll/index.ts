import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { electronCdpRef, type ElectronCdpApi } from "../../blueprints/electron-cdp";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe("Target Electron device id from `list-devices` (electron-cdp-<port>)."),
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

// Electron only. Touch platforms scroll with `gesture-swipe`; a desktop
// renderer scrolls with wheel events, which is exactly what this dispatches.
// Keeping the two as separate tools (instead of overloading swipe) means each
// platform has one obvious scroll verb and the capability gate explains the
// other one.
const capability: ToolCapability = {
  electron: { app: true },
};

export const gestureScrollTool: ToolDefinition<Params, Result> = {
  id: "gesture-scroll",
  description: `Scroll content in an Electron app by dispatching mouse-wheel events at a point. Anchor x/y are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Deltas are fractions of the window too: deltaY 0.5 scrolls down half a window; negative scrolls back up.
Use when content is below/above the fold (describe shows off-screen elements with zero height) or a list needs scrolling. Electron only — on iOS/Android use gesture-swipe.
Returns { scrolled: true, timestampMs }. Fails if the Electron CDP session is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "scroll wheel list page electron mouse down up content fold",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => ({
    electron: electronCdpRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const timestampMs = Date.now();
    const electron = services.electron as ElectronCdpApi;
    const vp = electron.getViewport();
    const totalDx = (params.deltaX ?? 0) * vp.width;
    const totalDy = (params.deltaY ?? 0) * vp.height;
    const durationMs = params.durationMs ?? 300;
    // Chunk into ~60fps wheel events so the renderer's scroll handlers fire
    // progressively, like a human rolling the wheel — one giant delta can
    // skip virtualized-list rendering and scroll-linked animations.
    const steps = Math.max(1, Math.round(durationMs / 16));
    const point = { x: params.x, y: params.y };
    for (let i = 0; i < steps; i++) {
      await electron.server.sendWheel(point, totalDx / steps, totalDy / steps);
      if (i < steps - 1) await sleep(16);
    }
    return { scrolled: true, timestampMs };
  },
};
