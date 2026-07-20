/**
 * Process-wide store backing the `map-app` crawler tool and the `/preview/map*`
 * UI endpoints.
 *
 * Same shape as `variant-proposals.ts`: the tool layer writes (the crawler
 * records screens/edges as it discovers them), the preview HTTP router reads
 * (`GET /preview/map` polls `snapshot()`), and both import the same module
 * singleton — so a node added mid-crawl is immediately visible to the browser,
 * with no channel between them beyond this store.
 *
 * Lifecycle: `begin()` opens a crawl session (one at a time — a second `begin`
 * while one is `running` throws) and resets the previous graph; the crawler
 * then streams `addNode` / `addEdge` / `patchNode` / `bumpStats` mutations;
 * exactly one of `complete()` / `cancel()` / `fail()` finalizes it. The graph
 * of the last finished crawl stays readable until the next `begin`, so the Map
 * tab keeps rendering after the tool returns.
 *
 * Events: `changed` fires on every mutation (the UI may live-refresh);
 * `mapSessionChanged(active)` fires on the begin/finalize transitions — the
 * tool-server's window manager listens and opens the preview window on the Map
 * tab when a crawl begins (honoring `openWindowRequested()`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, FailureError, TypedEventEmitter } from "@argent/registry";
import type {
  MapAction,
  MapCrawlLimits,
  MapCrawlState,
  MapCrawlStats,
  MapCrawlStatus,
  MapEdge,
  MapScreenNode,
} from "../tools/map/contract";

type StoreEvents = {
  /** Emitted whenever the crawl state changes (UI may live-refresh). */
  changed: () => void;
  /**
   * Emitted when a crawl session begins (`active=true`) or finalizes
   * (`active=false` — completed, cancelled, or failed). The tool-server's
   * composition layer listens: begin ⇒ open the preview window on the Map tab
   * (when `openWindowRequested()`); end deliberately leaves it open — the
   * human is reading the finished map.
   */
  mapSessionChanged: (active: boolean) => void;
};

/** What `begin()` needs to open a crawl session. */
export interface MapBeginInput {
  udid: string;
  bundleId: string;
  platform: "ios" | "android";
  limits: MapCrawlLimits;
  /** Whether the tool-server should open the preview window for this crawl. */
  openWindow: boolean;
}

/** Everything `addNode` records; the store mints the id and `discoveredAt`. */
export interface MapAddNodeInput {
  key: string;
  /** Best-effort title; null falls back to "Screen N". */
  title: string | null;
  depth: number;
  outside: boolean;
  actionsTotal: number;
  screenshotPath: string | null;
}

export class MapSessionStore {
  readonly events = new TypedEventEmitter<StoreEvents>();

  private status: MapCrawlStatus = "idle";
  private udid: string | null = null;
  private bundleId: string | null = null;
  private platform: "ios" | "android" | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private error: string | null = null;
  private limits: MapCrawlLimits | null = null;
  private stats: Omit<MapCrawlStats, "elapsedMs"> = {
    screens: 0,
    edges: 0,
    actionsExplored: 0,
    restarts: 0,
  };
  private rootId: string | null = null;
  private nodes: MapScreenNode[] = [];
  private edges: MapEdge[] = [];
  private openWindow = false;
  /**
   * Per-crawl directory the driver copies screenshots into
   * (`<tmpdir>/argent-map/<crawlId>`). Doubles as the serving allowlist for
   * `GET /preview/map/screenshot/:nodeId` — that route refuses any path that
   * does not resolve inside this directory. Survives finalize (thumbnails stay
   * servable for the finished map); replaced — and the previous one deleted —
   * on the next `begin`.
   */
  private screenshotDirPath: string | null = null;

  /**
   * Open a new crawl session, discarding the previous crawl's graph. One crawl
   * runs at a time: a `begin` while another is `running` throws a
   * `FailureError` (`MAP_CRAWL_ALREADY_RUNNING`). Returns the fresh crawl id
   * (also the screenshot directory's basename).
   */
  begin(input: MapBeginInput): { crawlId: string } {
    if (this.status === "running") {
      throw new FailureError(
        `A map crawl of "${this.bundleId ?? "an app"}" is already running — wait for it to ` +
          "finish (or cancel it) before starting another.",
        {
          error_code: FAILURE_CODES.MAP_CRAWL_ALREADY_RUNNING,
          failure_stage: "map_session_begin",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    // Best-effort cleanup of the previous crawl's thumbnails: they live under
    // the OS temp dir, but a long-lived tool-server would otherwise accumulate
    // one directory per crawl.
    if (this.screenshotDirPath) {
      try {
        fs.rmSync(this.screenshotDirPath, { recursive: true, force: true });
      } catch {
        /* best-effort: a vanished dir must not block a new crawl */
      }
    }

    const crawlId = randomUUID();
    this.status = "running";
    this.udid = input.udid;
    this.bundleId = input.bundleId;
    this.platform = input.platform;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.error = null;
    this.limits = { ...input.limits };
    this.stats = { screens: 0, edges: 0, actionsExplored: 0, restarts: 0 };
    this.rootId = null;
    this.nodes = [];
    this.edges = [];
    this.openWindow = input.openWindow;
    this.screenshotDirPath = path.join(os.tmpdir(), "argent-map", crawlId);

    this.events.emit("changed");
    this.events.emit("mapSessionChanged", true);
    return { crawlId };
  }

  /**
   * Record a newly discovered screen. Mints the id ("s0", "s1", … in discovery
   * order), applies the "Screen N" title fallback, sets `rootId` on the first
   * node, and counts non-`outside` nodes into `stats.screens`. Returns a copy
   * of the stored node (callers must go through `patchNode` to mutate).
   */
  addNode(input: MapAddNodeInput): MapScreenNode {
    const node: MapScreenNode = {
      id: `s${this.nodes.length}`,
      key: input.key,
      title: input.title?.trim() || `Screen ${this.nodes.length + 1}`,
      depth: input.depth,
      outside: input.outside,
      actionsTotal: input.actionsTotal,
      actionsExplored: 0,
      exhausted: false,
      screenshotPath: input.screenshotPath,
      discoveredAt: Date.now(),
    };
    this.nodes.push(node);
    if (this.rootId === null) this.rootId = node.id;
    if (!node.outside) this.stats.screens += 1;
    this.events.emit("changed");
    return { ...node };
  }

  /** Record a traversed transition between two recorded screens. */
  addEdge(from: string, to: string, action: MapAction): MapEdge {
    const edge: MapEdge = {
      id: `e${this.edges.length}`,
      from,
      to,
      action: copyAction(action),
    };
    this.edges.push(edge);
    this.stats.edges += 1;
    this.events.emit("changed");
    return { ...edge, action: copyAction(edge.action) };
  }

  /** Update a recorded node's mutable fields. Unknown ids are ignored. */
  patchNode(
    id: string,
    patch: Partial<
      Pick<MapScreenNode, "title" | "actionsExplored" | "exhausted" | "screenshotPath">
    >
  ): void {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch);
    this.events.emit("changed");
  }

  /** Add deltas onto the crawl counters (e.g. `{ restarts: 1 }`). */
  bumpStats(delta: Partial<Pick<MapCrawlStats, "actionsExplored" | "restarts">>): void {
    if (delta.actionsExplored) this.stats.actionsExplored += delta.actionsExplored;
    if (delta.restarts) this.stats.restarts += delta.restarts;
    this.events.emit("changed");
  }

  /** Finalize the running crawl as completed. No-op unless `running`. */
  complete(): void {
    this.finalize("completed", null);
  }

  /** Finalize the running crawl as cancelled, keeping the partial graph. */
  cancel(): void {
    this.finalize("cancelled", null);
  }

  /** Finalize the running crawl as failed, keeping the partial graph. */
  fail(message: string): void {
    this.finalize("failed", message);
  }

  // The single finalize choke point: only a `running` session can finalize (a
  // second finalize — e.g. the tool's defensive try/finally after the crawler
  // already cancelled — is a no-op), so status can never regress and
  // `mapSessionChanged(false)` fires exactly once per crawl.
  private finalize(
    status: Exclude<MapCrawlStatus, "idle" | "running">,
    error: string | null
  ): void {
    if (this.status !== "running") return;
    this.status = status;
    this.error = error;
    this.finishedAt = Date.now();
    this.events.emit("changed");
    this.events.emit("mapSessionChanged", false);
  }

  /**
   * The full crawl state — exactly the `GET /preview/map` wire shape. Deep
   * copies throughout, so a caller mutating the snapshot can never corrupt the
   * store. `elapsedMs` is live while running, frozen once finalized.
   */
  snapshot(): MapCrawlState {
    const elapsedMs =
      this.startedAt === null
        ? 0
        : (this.finishedAt ?? (this.status === "running" ? Date.now() : this.startedAt)) -
          this.startedAt;
    return {
      status: this.status,
      udid: this.udid,
      bundleId: this.bundleId,
      platform: this.platform,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      limits: this.limits ? { ...this.limits } : null,
      stats: { ...this.stats, elapsedMs },
      rootId: this.rootId,
      nodes: this.nodes.map((n) => ({ ...n })),
      edges: this.edges.map((e) => ({ ...e, action: copyAction(e.action) })),
    };
  }

  /** A recorded node's screenshot path, or null (unknown id / no capture). */
  screenshotPathFor(nodeId: string): string | null {
    return this.nodes.find((n) => n.id === nodeId)?.screenshotPath ?? null;
  }

  /**
   * The current session's screenshot directory (null before the first crawl).
   * The driver writes into it; the screenshot route allowlists against it.
   */
  sessionScreenshotDir(): string | null {
    return this.screenshotDirPath;
  }

  /** Whether the current session asked for the preview window to open. */
  openWindowRequested(): boolean {
    return this.openWindow;
  }
}

function copyAction(action: MapAction): MapAction {
  return { ...action, selector: { ...action.selector }, frame: { ...action.frame } };
}

/** Module singleton — shared by the `map-app` tool and the preview router. */
export const mapSessionStore = new MapSessionStore();
