import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { resolveDevice } from "../../utils/device-info";
import { macosAppServices, macosScroll, requireMacosApp } from "../../utils/macos-input";

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

// Desktop only: a Chromium renderer scrolls with wheel events and a Mac app
// through its in-app library, so touch platforms use `gesture-swipe` instead.
const capability: ToolCapability = {
  chromium: { app: true },
  macos: { app: true, catalyst: true },
};

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe(
        "Chromium device id (`chromium-cdp-<port>`)<flag:macos-apps> or Mac app id</flag:macos-apps> from `list-devices`."
      ),
    x: z.number().min(0).max(1).describe("Normalized anchor x over the scrollable element."),
    y: z.number().min(0).max(1).describe("Normalized anchor y."),
    deltaX: z.number().optional().describe("Horizontal scroll fraction (+ right, - left)."),
    deltaY: z.number().optional().describe("Vertical scroll fraction (+ down, - up; e.g. 0.5)."),
    durationMs: z
      .number()
      .optional()
      .describe(
        "Scroll duration in ms (default 300)<flag:macos-apps>; ignored on Mac apps</flag:macos-apps>."
      ),
  })
  .refine((p) => (p.deltaX ?? 0) !== 0 || (p.deltaY ?? 0) !== 0, {
    message: "Pass a non-zero deltaX and/or deltaY — a scroll with no delta is a no-op.",
  });

type Params = z.infer<typeof zodSchema>;

export const gestureScrollTool: ToolDefinition<Params, Result> = {
  id: "gesture-scroll",
  description: `Send mouse-wheel scroll events at normalized [0,1] anchor (x, y) in Chromium<flag:macos-apps> or a Mac app</flag:macos-apps>.
Use when scrolling desktop lists or off-screen content (use \`gesture-swipe\` on iOS/Android<flag:harmonyos>/HarmonyOS</flag:harmonyos>).
Returns \`{ scrolled: true, timestampMs }\`. Fails if CDP is unreachable<flag:macos-apps> or nothing under the point scrolls on a Mac app</flag:macos-apps>.`,
  zodSchema,
  searchHint:
    "scroll wheel list page chromium<flag:macos-apps> mac</flag:macos-apps> mouse down up content fold",
  interaction: {
    startedMsg: ({ params }) => `Scrolling ${scrollDirection(params)}`,
    completedMsg: ({ params }) => `Scrolled ${scrollDirection(params)}`,
    failedMsg: ({ failureSignal }) => `Failed to scroll: ${failureSignal.error_code}`,
  },
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
