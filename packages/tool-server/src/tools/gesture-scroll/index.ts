import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result {
  scrolled: boolean;
  timestampMs: number;
}

function scrollDirection(params: Params): string {
  const horizontal = (params.deltaX ?? 0) > 0 ? "right" : "left";
  const vertical = (params.deltaY ?? 0) > 0 ? "down" : "up";
  if ((params.deltaX ?? 0) === 0) return vertical;
  if ((params.deltaY ?? 0) === 0) return horizontal;
  return `${vertical} and ${horizontal}`;
}

// Chromium only: a desktop renderer scrolls with wheel events, so touch
// platforms use `gesture-swipe` instead.
const capability: ToolCapability = {
  chromium: { app: true },
};

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe("Target Chromium device id from `list-devices` (chromium-cdp-<port>)."),
    x: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Anchor x. The wheel events land here; put it over the element you want to scroll."
      ),
    y: z.number().min(0).max(1).describe("Anchor y."),
    deltaX: z
      .number()
      .optional()
      .describe(
        "Horizontal scroll distance as a fraction of the window width. Positive reveals content to the right; negative scrolls back left."
      ),
    deltaY: z
      .number()
      .optional()
      .describe(
        "Vertical scroll distance as a fraction of the window height (0.5 = half a window). Positive scrolls down (reveals content below), like rolling a mouse wheel toward you; negative scrolls back up."
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

export const gestureScrollTool: ToolDefinition<Params, Result> = {
  id: "gesture-scroll",
  description: `Send mouse-wheel events at a point to scroll content in a Chromium app. The anchor x/y and the deltas are fractions of the window (not pixels); x/y match gesture-tap and describe.
Use when content is below/above the fold (describe shows off-screen elements with zero height) or a list needs scrolling. Chromium only: on iOS/Android<flag:harmonyos> and HarmonyOS</flag:harmonyos> use gesture-swipe.
Returns { scrolled: true, timestampMs }. Fails if the Chromium CDP session is not reachable for the given device.`,
  zodSchema,
  searchHint: "scroll wheel list page chromium mouse down up content fold",
  interaction: {
    startedMsg: ({ params }) => `Scrolling ${scrollDirection(params)}`,
    completedMsg: ({ params }) => `Scrolled ${scrollDirection(params)}`,
    failedMsg: ({ failureSignal }) => `Failed to scroll: ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => ({
    chromium: chromiumCdpRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const timestampMs = Date.now();
    const chromium = services.chromium as ChromiumCdpApi;
    await assertChromiumWindowVisible(chromium, "scroll");
    const vp = chromium.getViewport();
    const totalDx = (params.deltaX ?? 0) * vp.width;
    const totalDy = (params.deltaY ?? 0) * vp.height;
    const durationMs = params.durationMs ?? 300;
    // ~60fps chunks: one giant delta can skip virtualized-list rendering and
    // scroll-linked animations.
    const steps = Math.max(1, Math.round(durationMs / 16));
    const point = { x: params.x, y: params.y };
    for (let i = 0; i < steps; i++) {
      await chromium.server.sendWheel(point, totalDx / steps, totalDy / steps);
      if (i < steps - 1) await sleep(16);
    }
    return { scrolled: true, timestampMs };
  },
};
