/**
 * Shared shapes for the `map-app` crawler: the tool, the in-process
 * `mapSessionStore`, the `/preview/map*` routes, and (as JSON) the Map tab in
 * the preview window and the `argent map` CLI all speak these types.
 *
 * A "screen" is identified by a coarse structural fingerprint of its describe
 * tree (roles + identifiers + coarsely rounded frames, no labels/values), so
 * revisits with different dynamic content — feed items, counters, timestamps —
 * collapse into one node while structurally different screens stay distinct.
 */

/** Normalized [0..1] rectangle in the same space describe frames use. */
export interface MapFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How the crawler re-locates an element when replaying a path. */
export interface MapSelector {
  /**
   * `identifier` — accessibilityIdentifier / resource-id / DOM id (preferred).
   * `label` — accessibility label / text (exact).
   * `frame` — no stable handle existed; re-tap the recorded frame centre.
   */
  by: "identifier" | "label" | "frame";
  /** Matcher value for `identifier`/`label`; empty string for `frame`. */
  value: string;
}

/** One tappable element the crawler acted (or plans to act) on. */
export interface MapAction {
  /** Human-readable: label, identifier, or role of the tapped element. */
  label: string;
  role: string;
  selector: MapSelector;
  /** Element frame at the time it was enumerated. */
  frame: MapFrame;
}

export interface MapScreenNode {
  /** Stable within one crawl: "s0", "s1", ... in discovery order. */
  id: string;
  /** Coarse structural fingerprint — the dedup key. */
  key: string;
  /** Best-effort human title (nav-bar/header text), falls back to "Screen N". */
  title: string;
  /**
   * True when this screen is an ENTRY POINT — the app's launch screen, or a
   * screen reached by a deep link (`--deep-link`). An app is a graph with
   * potentially several ways in, so entries are a set, not a single root; a
   * node is not stamped with a "depth" because a screen has no intrinsic
   * distance from anywhere — it is reachable by many paths of differing length.
   */
  entry: boolean;
  /** True for the synthetic "left the app" node (home screen / other app). */
  outside: boolean;
  /** Actionable elements enumerated on this screen (after caps/dedup). */
  actionsTotal: number;
  actionsExplored: number;
  /** All enumerated actions explored, or the screen was budget-capped. */
  exhausted: boolean;
  /** Set when a PNG thumbnail was captured; served by
   * `GET /preview/map/screenshot/:nodeId`. Absolute path, tool-server host. */
  screenshotPath: string | null;
  discoveredAt: number;
}

export interface MapEdge {
  id: string;
  /** MapScreenNode ids. */
  from: string;
  to: string;
  action: MapAction;
}

export type MapCrawlStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface MapCrawlLimits {
  maxScreens: number;
  maxActionsPerScreen: number;
  maxDepth: number;
  timeBudgetMs: number;
}

export interface MapCrawlStats {
  screens: number;
  edges: number;
  actionsExplored: number;
  /** Times the crawler had to relaunch the app to get back on the map. */
  restarts: number;
  elapsedMs: number;
}

/**
 * Full crawl state. `GET /preview/map` returns exactly this shape; the
 * `map-app` tool result is this shape minus `screenshotPath` host paths
 * (replaced by nothing — CLI consumers use counts and the preview URL).
 */
export interface MapCrawlState {
  status: MapCrawlStatus;
  udid: string | null;
  bundleId: string | null;
  platform: "ios" | "android" | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Present when status is "failed". */
  error: string | null;
  limits: MapCrawlLimits | null;
  stats: MapCrawlStats;
  /**
   * Entry-point node ids in discovery order (`nodes[i].entry === true` for
   * exactly these). The launch screen is the first; deep-link seeds add more.
   * Empty until the first screen is recorded. Replaces the former single
   * `rootId` — an app graph can have several entries.
   */
  entryPoints: string[];
  nodes: MapScreenNode[];
  edges: MapEdge[];
}

/** Progress events the tool emits (NDJSON `progress` lines to the CLI). */
export type MapProgressEvent =
  // `depth` here is live TRAVERSAL feedback — how many taps deep the crawl is
  // standing right now — not a property of the screen (screens have no depth;
  // see MapScreenNode). It is shown in the CLI's progress line only.
  | { kind: "screen"; nodeId: string; title: string; depth: number; screens: number }
  | { kind: "action"; nodeId: string; label: string; explored: number; total: number }
  | { kind: "restart"; reason: string }
  | { kind: "phase"; message: string };

export const MAP_DEFAULT_LIMITS: MapCrawlLimits = {
  maxScreens: 30,
  maxActionsPerScreen: 12,
  maxDepth: 5,
  timeBudgetMs: 5 * 60 * 1000,
};
