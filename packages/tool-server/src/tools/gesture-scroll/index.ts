import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";
import { macosAppServices, macosScroll, requireMacosApp } from "../../utils/macos-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe(
        "Target Chromium device id from `list-devices` (chromium-cdp-<port>)<flag:macos-apps>, or a Mac app id (macos-app-<bundle id>)</flag:macos-apps>."
      ),
    x: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Anchor x: normalized 0.0–1.0 (fraction of window width, not pixels). The wheel events land here; put it over the element you want to scroll."
      ),
    y: z
      .number()
      .min(0)
      .max(1)
      .describe("Anchor y: normalized 0.0–1.0 (fraction of window height, not pixels)."),
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
        "Spread the scroll over this many milliseconds in wheel-event steps (default 300) so scroll handlers fire progressively.<flag:macos-apps> Ignored on a Mac app, which scrolls the whole delta in one step.</flag:macos-apps>"
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

function scrollDirection(params: Params): string {
  const horizontal = (params.deltaX ?? 0) > 0 ? "right" : "left";
  const vertical = (params.deltaY ?? 0) > 0 ? "down" : "up";
  if ((params.deltaX ?? 0) === 0) return vertical;
  if ((params.deltaY ?? 0) === 0) return horizontal;
  return `${vertical} and ${horizontal}`;
}

// Desktop only: a Chromium renderer scrolls with wheel events and a Mac app
// through its in-app library, so touch platforms use `gesture-swipe` instead.
const capability: ToolCapability = {
  chromium: { app: true },
  macos: { app: true },
};

export const gestureScrollTool: ToolDefinition<Params, Result> = {
  id: "gesture-scroll",
  interaction: {
    startedMsg: ({ params }) => `Scrolling ${scrollDirection(params)}`,
    completedMsg: ({ params }) => `Scrolled ${scrollDirection(params)}`,
    failedMsg: ({ failureSignal }) => `Failed to scroll: ${failureSignal.error_code}`,
  },
  description: `Scroll content in a Chromium app by dispatching mouse-wheel events at a point<flag:macos-apps>, or in a Mac app by scrolling what is under the point as a mouse wheel does (a scroll view, a web scroller, a view that scrolls itself)</flag:macos-apps>. Anchor x/y are normalized 0.0–1.0 (fractions of the window, not pixels), same coordinate space as gesture-tap and describe. Deltas are fractions of the window too: deltaY 0.5 scrolls down half a window; negative scrolls back up.
Use when content is below/above the fold (describe shows off-screen elements with zero height) or a list needs scrolling. Chromium<flag:macos-apps> and Mac apps</flag:macos-apps> only: on iOS/Android<flag:harmonyos> and HarmonyOS</flag:harmonyos> use gesture-swipe.
Returns { scrolled: true, timestampMs }. Fails if the Chromium CDP session<flag:macos-apps> or the Mac app library</flag:macos-apps> is not reachable for the given device<flag:macos-apps>, or, on a Mac app, when nothing under the point scrolls</flag:macos-apps>.`,
  searchHint:
    "scroll wheel list page chromium<flag:macos-apps> mac</flag:macos-apps> mouse down up content fold",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "macos") return macosAppServices(device);
    return { chromium: chromiumCdpRef(device) };
  },
  async execute(services, params) {
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);
    if (device.platform === "macos") {
      const app = requireMacosApp(services, "gesture-scroll", device);
      // Window fractions on both sides, so the deltas pass through as given.
      await macosScroll(app, {
        x: params.x,
        y: params.y,
        deltaX: params.deltaX,
        deltaY: params.deltaY,
      });
      return { scrolled: true, timestampMs };
    }
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
