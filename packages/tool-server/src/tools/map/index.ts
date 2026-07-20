import { z } from "zod";
import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";
import { mapSessionStore } from "../../utils/map-session";
import {
  MAP_DEFAULT_LIMITS,
  type MapCrawlLimits,
  type MapCrawlStats,
  type MapCrawlStatus,
  type MapProgressEvent,
} from "./contract";
import { crawlApp } from "./crawler";
import { createMapDriver } from "./driver";

export const MAP_APP_TOOL_ID = "map-app";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .describe("The app to crawl (iOS bundle id / Android package name). Must be installed."),
  maxScreens: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      `Stop after discovering this many screens (default ${MAP_DEFAULT_LIMITS.maxScreens}, max 100).`
    ),
  maxActionsPerScreen: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe(
      `Try at most this many tappable elements per screen (default ${MAP_DEFAULT_LIMITS.maxActionsPerScreen}).`
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe(
      `Do not navigate deeper than this many taps from the start screen (default ${MAP_DEFAULT_LIMITS.maxDepth}).`
    ),
  timeBudgetS: z
    .number()
    .int()
    .positive()
    .max(1800)
    .optional()
    .describe(
      `Overall crawl time budget in seconds (default ${MAP_DEFAULT_LIMITS.timeBudgetMs / 1000}, max 1800). The crawl finishes with a partial map when it runs out.`
    ),
  deepLinks: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      "Extra entry points to seed (deep-link URLs / URL schemes, e.g. myapp://settings). After the launch crawl, each is opened and mapped as an additional entry — reaching screens the launch screen never links to. A link that fails or leaves the app is skipped."
    ),
  openWindow: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Open the Argent preview window on the Map tab so the graph is visible live (default true)."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface MapAppResult {
  status: MapCrawlStatus;
  stats: MapCrawlStats;
  /** Entry-point node ids (the launch screen, then any deep-link seeds). */
  entryPoints: string[];
  /** Discovered screens, trimmed — the full graph is served at `mapUrl`. */
  nodes: Array<{ id: string; title: string; entry: boolean; outside: boolean }>;
  edgesCount: number;
  mapUrl: string;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  android: { emulator: true, device: true },
};

export function createMapAppTool(registry: Registry): ToolDefinition<Params, MapAppResult> {
  return {
    id: MAP_APP_TOOL_ID,
    description: `Crawl an app and build a map of its reachable screens: launches the app, systematically taps through its tappable elements, and records every distinct screen and the transitions between them as a directed graph, with a screenshot per screen.

Use it to get oriented in an unfamiliar app, to inventory its screens before writing flows or tests, or to produce a navigation overview a human can explore — the graph renders live in the Argent preview window's Map tab while the crawl runs (openWindow: false to skip the window).

An app is a graph, not a tree: it can have several entry points. The crawl starts from the launch screen and, given deepLinks, seeds each as an extra entry — reaching screens the launch screen never links to (a settings pane, a detail view behind a link). Every discovered entry is marked in the result and the map.

The crawler is careful but not read-only: it taps real UI. It skips text fields, disabled elements, and destructive-looking actions (log out / sign out / delete), collapses repeated list items, and honors screen/depth/time budgets — but the app's state may still change, so prefer a test account or throwaway build. One crawl runs at a time; progress events stream while it runs, and cancelling the call keeps the partial map.

Returns { status, stats, entryPoints, nodes, edgesCount, mapUrl } — a trimmed summary. The full graph (screens, edges, action labels, screenshots) stays available at mapUrl.`,
    searchHint: "map crawl app screens graph navigation explore sitemap overview inventory",
    longRunning: true,
    featureFlag: "argent-map",
    zodSchema,
    capability,
    // No eagerly-declared service: every step dispatches existing tools
    // through the registry (each resolving its own services), and the tree
    // read resolves the describe services internally — like await-ui-element.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const device = resolveDevice(params.udid);
      assertSupported(MAP_APP_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else await ensureDeps(androidRequires);
      const platform = device.platform as "ios" | "android";

      const limits: MapCrawlLimits = {
        maxScreens: params.maxScreens ?? MAP_DEFAULT_LIMITS.maxScreens,
        maxActionsPerScreen: params.maxActionsPerScreen ?? MAP_DEFAULT_LIMITS.maxActionsPerScreen,
        maxDepth: params.maxDepth ?? MAP_DEFAULT_LIMITS.maxDepth,
        timeBudgetMs:
          params.timeBudgetS !== undefined
            ? params.timeBudgetS * 1000
            : MAP_DEFAULT_LIMITS.timeBudgetMs,
      };

      // Throws MAP_CRAWL_ALREADY_RUNNING when a crawl is in flight; also emits
      // mapSessionChanged(true), which opens the preview window (openWindow
      // permitting) via the listener in src/index.ts.
      mapSessionStore.begin({
        udid: params.udid,
        bundleId: params.bundleId,
        platform,
        limits,
        openWindow: params.openWindow,
      });

      const driver = createMapDriver({
        registry,
        ctx,
        device,
        bundleId: params.bundleId,
        screenshotDir: mapSessionStore.sessionScreenshotDir()!,
      });

      const emitProgress = ctx?.emitProgress;
      try {
        await crawlApp({
          driver,
          store: mapSessionStore,
          limits,
          platform,
          bundleId: params.bundleId,
          deepLinks: params.deepLinks,
          signal: ctx?.signal,
          emitProgress: emitProgress ? (event: MapProgressEvent) => emitProgress(event) : undefined,
        });
      } catch (err) {
        if (ctx?.signal?.aborted) {
          // The client cancelled mid-step and the abort surfaced as a sub-tool
          // rejection: finalize as cancelled (partial graph kept) and resolve
          // normally with the cancelled summary — cancellation is an outcome
          // here, not an error.
          mapSessionStore.cancel();
        } else {
          mapSessionStore.fail(err instanceof Error ? err.message : String(err));
          throw err;
        }
      } finally {
        // Hard invariant: execute must never return with the store still
        // "running" — the /preview/map poller would spin forever. The crawler
        // finalizes every path it knows about; this is the belt-and-braces.
        if (mapSessionStore.snapshot().status === "running") {
          mapSessionStore.fail("map crawl ended without finalizing");
        }
      }

      const snap = mapSessionStore.snapshot();
      return {
        status: snap.status,
        stats: snap.stats,
        entryPoints: snap.entryPoints,
        nodes: snap.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          entry: n.entry,
          outside: n.outside,
        })),
        edgesCount: snap.edges.length,
        mapUrl:
          `http://127.0.0.1:${process.env.ARGENT_PORT ?? "3001"}/preview/` +
          `?udid=${encodeURIComponent(params.udid)}&tab=map`,
      };
    },
  };
}
