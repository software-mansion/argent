import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { DescribeNode } from "../describe/contract";
import { selectorToFrame } from "../../utils/ui-tree-match";
import type { MapSessionStore } from "../../utils/map-session";
import type { MapAction, MapCrawlLimits, MapFrame, MapProgressEvent } from "./contract";
import { enumerateActions } from "./actions";
import { screenKey, screenTitle } from "./fingerprint";

/**
 * The `map-app` crawl engine: pure DFS logic over an abstract {@link CrawlDriver},
 * so unit tests drive it with a simulated app while the real tool wires it to
 * the device (see driver.ts).
 *
 * Traversal is DFS with restart-replay backtracking (the standard app-crawler
 * shape): every screen node remembers the action path that first discovered it,
 * so the crawler can always get back to any frontier screen by relaunching the
 * app from scratch and replaying that path — the one navigation primitive that
 * works on every app, with the cheaper back-heuristic tried first.
 */

/** What the crawler needs from the outside world. All methods may reject. */
export interface CrawlDriver {
  /** The raw describe tree of the current screen. */
  fetchTree(): Promise<DescribeNode>;
  /** Tap at a normalized [0..1] point. */
  tap(x: number, y: number): Promise<void>;
  /**
   * Press the platform back control if one exists (Android hardware back).
   * Resolves false when the platform has none (iOS) — the caller then falls
   * back to the on-screen heuristic / restart-replay.
   */
  pressBack(): Promise<boolean>;
  /** Terminate and relaunch the app (a guaranteed return to its root screen). */
  restartApp(): Promise<void>;
  /** (Re-)foreground the app without resetting its state. */
  launchApp(): Promise<void>;
  /** Wait briefly for animations/loads to settle. Never rejects on "unsettled". */
  awaitSettle(): Promise<void>;
  /** Capture + persist a screenshot for `nodeId`; null when capture failed. */
  screenshot(nodeId: string): Promise<string | null>;
  /** Monotonic-enough clock for the time budget (injectable for tests). */
  now(): number;
}

export interface CrawlAppOptions {
  driver: CrawlDriver;
  store: MapSessionStore;
  limits: MapCrawlLimits;
  platform: "ios" | "android";
  bundleId: string;
  signal?: AbortSignal;
  emitProgress?: (event: MapProgressEvent) => void;
}

// Internal crawl bookkeeping per screen (the store holds the wire-shaped
// node; this holds what traversal needs: the replay path and action cursor).
interface CrawlNode {
  id: string;
  key: string;
  depth: number;
  /** First-discovery action path from the root — the restart-replay recipe. */
  path: MapAction[];
  actions: MapAction[];
  /** Index of the next unexplored action. */
  nextAction: number;
  exhausted: boolean;
}

// iOS back heuristic: a leading (left-edge) button in the top sliver of the
// screen is almost always the navigation back control.
const IOS_BACK_MAX_Y = 0.08;
const IOS_BACK_MAX_X = 0.25;

function centreOf(frame: MapFrame): { x: number; y: number } {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

/**
 * Android "left the app" tell: resource-ids are package-qualified
 * (`com.pkg:id/name`), so a tree whose ids all belong to OTHER packages is
 * another app / the launcher. The `android:` namespace is shared framework
 * chrome and proves nothing either way. A tree with no qualified ids at all is
 * treated as still-in-app (Compose screens often carry none). iOS has no
 * equivalent signal — there, leaving the app surfaces as a failed or empty
 * describe, handled by the caller.
 */
export function treeLooksOutside(
  tree: DescribeNode,
  bundleId: string,
  platform: "ios" | "android"
): boolean {
  if (platform !== "android") return false;
  const packages = new Set<string>();
  const walk = (node: DescribeNode): void => {
    const id = node.identifier;
    if (id) {
      const match = /^([A-Za-z][A-Za-z0-9_.]*):id\//.exec(id);
      if (match && match[1] !== "android") packages.add(match[1]!);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  if (packages.size === 0) return false;
  return !packages.has(bundleId);
}

/**
 * Crawl the app and record the screen graph into `store`. Resolves
 * "completed" (budgets/frontier exhausted) or "cancelled" (signal aborted —
 * the partial graph is kept and the store finalized as cancelled). Rejects
 * only on a hard failure (e.g. the app never became readable); the CALLER
 * finalizes the store as failed then.
 */
export async function crawlApp(opts: CrawlAppOptions): Promise<"completed" | "cancelled"> {
  try {
    return await runCrawl(opts);
  } catch (err) {
    // An abort can surface as a rejected sub-call (tap/fetch racing the
    // disconnect) instead of tripping a loop-top check. That is still a
    // cancellation, not a failure: keep the partial graph.
    if (opts.signal?.aborted) {
      opts.store.cancel();
      return "cancelled";
    }
    throw err;
  }
}

async function runCrawl(opts: CrawlAppOptions): Promise<"completed" | "cancelled"> {
  const { driver, store, limits, platform, bundleId, signal } = opts;
  const emit = opts.emitProgress ?? (() => {});
  const startedAt = driver.now();

  const byKey = new Map<string, CrawlNode>();
  const crawlNodes: CrawlNode[] = [];
  let outsideNodeId: string | null = null;
  let screens = 0;

  const aborted = (): boolean => signal?.aborted === true;
  const overTime = (): boolean => driver.now() - startedAt >= limits.timeBudgetMs;

  /**
   * Read the current screen, or null when we're outside the app: the fetch
   * failed, the tree is empty (after one settle-and-retry — an accessibility
   * tree can be briefly blank right after a navigation), or the tree belongs
   * to another package. An abort mid-fetch rethrows so cancellation is never
   * misread as "left the app".
   */
  async function readTree(): Promise<DescribeNode | null> {
    let tree: DescribeNode;
    try {
      tree = await driver.fetchTree();
    } catch (err) {
      if (aborted()) throw err;
      return null;
    }
    if (tree.children.length === 0) {
      await driver.awaitSettle();
      try {
        tree = await driver.fetchTree();
      } catch (err) {
        if (aborted()) throw err;
        return null;
      }
      if (tree.children.length === 0) return null;
    }
    return treeLooksOutside(tree, bundleId, platform) ? null : tree;
  }

  function markExhausted(node: CrawlNode): void {
    if (node.exhausted) return;
    node.exhausted = true;
    store.patchNode(node.id, { exhausted: true });
  }

  /** Record a newly discovered in-app screen (store node + screenshot). */
  async function createNode(
    tree: DescribeNode,
    depth: number,
    path: MapAction[]
  ): Promise<CrawlNode> {
    const key = screenKey(tree);
    const actions = enumerateActions(tree, { platform, maxActions: limits.maxActionsPerScreen });
    const stored = store.addNode({
      key,
      title: screenTitle(tree),
      depth,
      outside: false,
      actionsTotal: actions.length,
      screenshotPath: null,
    });
    const node: CrawlNode = {
      id: stored.id,
      key,
      depth,
      path,
      actions,
      nextAction: 0,
      exhausted: false,
    };
    if (actions.length === 0) markExhausted(node);
    byKey.set(key, node);
    crawlNodes.push(node);
    screens += 1;
    const shot = await driver.screenshot(stored.id);
    if (shot) store.patchNode(stored.id, { screenshotPath: shot });
    emit({ kind: "screen", nodeId: stored.id, title: stored.title, depth, screens });
    return node;
  }

  /** The single synthetic "left the app" node, created on first use. */
  function ensureOutsideNode(depth: number): string {
    if (outsideNodeId !== null) return outsideNodeId;
    const stored = store.addNode({
      key: "__outside__",
      title: "Outside the app",
      depth,
      outside: true,
      actionsTotal: 0,
      screenshotPath: null,
    });
    store.patchNode(stored.id, { exhausted: true });
    outsideNodeId = stored.id;
    return stored.id;
  }

  /**
   * Where to tap when replaying `action` on the current `tree`: resolve the
   * recorded selector against the live tree (ranked matching, exact beats
   * substring — `selectorToFrame`), falling back to the recorded frame's
   * centre when nothing matches.
   */
  function replayTapPoint(tree: DescribeNode, action: MapAction): { x: number; y: number } {
    const sel = action.selector;
    const frame =
      sel.by === "identifier"
        ? selectorToFrame(tree, { identifier: sel.value })
        : sel.by === "label"
          ? selectorToFrame(tree, { text: sel.value })
          : undefined;
    if (frame) {
      return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    }
    return centreOf(action.frame);
  }

  /**
   * Restart the app and replay `target`'s discovery path. True when we land on
   * a screen with `target`'s key; false on divergence (the path no longer
   * leads there — dynamic content moved, an interstitial appeared) or abort.
   */
  async function replayTo(target: CrawlNode, reason: string): Promise<boolean> {
    store.bumpStats({ restarts: 1 });
    emit({ kind: "restart", reason });
    await driver.restartApp();
    await driver.awaitSettle();
    for (const step of target.path) {
      if (aborted()) return false;
      const tree = await readTree();
      if (!tree) return false;
      const point = replayTapPoint(tree, step);
      await driver.tap(point.x, point.y);
      await driver.awaitSettle();
    }
    const tree = await readTree();
    return tree !== null && screenKey(tree) === target.key;
  }

  /** iOS back heuristic: the leading top-left button on the current screen. */
  function iosBackPoint(tree: DescribeNode): { x: number; y: number } | null {
    let best: DescribeNode | undefined;
    const walk = (node: DescribeNode): void => {
      const f = node.frame;
      if (
        /button/i.test(node.role) &&
        node.disabled !== true &&
        f.width > 0 &&
        f.height > 0 &&
        f.y <= IOS_BACK_MAX_Y &&
        f.x <= IOS_BACK_MAX_X &&
        (best === undefined || f.x < best.frame.x)
      ) {
        best = node;
      }
      for (const child of node.children) walk(child);
    };
    for (const child of tree.children) walk(child);
    if (best === undefined) return null;
    const f = best.frame;
    return { x: f.x + f.width / 2, y: f.y + f.height / 2 };
  }

  /**
   * Get from the screen we're standing on (`hereTree`) back to `current`:
   * back heuristic first (Android hardware back; iOS leading top-left button),
   * verified by key; restart-replay when that fails. Returns the node we end
   * up standing on, or null when even the replay diverged (or we aborted).
   *
   * The back tap often lands on a *different* known screen than the one asked
   * for — closing a sheet drops to its presenter, not to the sheet page we
   * came from. When that screen still has unexplored actions, it is adopted
   * as the new position instead of paying a restart: `current`'s remaining
   * actions stay pending, and the frontier backtrack returns to it later.
   */
  async function returnToCurrent(
    current: CrawlNode,
    hereTree: DescribeNode
  ): Promise<CrawlNode | null> {
    let backTried = false;
    if (platform === "android") {
      backTried = await driver.pressBack();
    } else {
      const point = iosBackPoint(hereTree);
      if (point) {
        await driver.tap(point.x, point.y);
        backTried = true;
      }
    }
    if (backTried) {
      await driver.awaitSettle();
      const tree = await readTree();
      if (tree) {
        const key = screenKey(tree);
        if (key === current.key) return current;
        const landed = byKey.get(key);
        if (landed && !landed.exhausted && landed.nextAction < landed.actions.length) {
          return landed;
        }
      }
    }
    if (aborted()) return null;
    const ok = await replayTo(
      current,
      `back navigation did not reach ${current.id}; replaying its path`
    );
    return ok ? current : null;
  }

  // ── Launch and root discovery ─────────────────────────────────────────
  emit({ kind: "phase", message: `Launching ${bundleId}` });
  await driver.launchApp();
  await driver.awaitSettle();
  const rootTree = await readTree();
  if (!rootTree) {
    throw new FailureError(
      `The app's UI never became readable after launching "${bundleId}" — ` +
        "check that the bundle id is correct, the app is installed, and it stays in the foreground.",
      {
        error_code: FAILURE_CODES.MAP_APP_NOT_VISIBLE,
        failure_stage: "map_crawl_launch",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  let current = await createNode(rootTree, 0, []);

  // ── Main DFS loop ─────────────────────────────────────────────────────
  while (true) {
    if (aborted()) {
      store.cancel();
      return "cancelled";
    }
    if (overTime()) {
      emit({ kind: "phase", message: "Time budget exhausted — finishing with a partial map" });
      break;
    }
    if (screens >= limits.maxScreens) {
      emit({ kind: "phase", message: "Screen cap reached — finishing with a partial map" });
      break;
    }

    // Exhausted current ⇒ backtrack to the shallowest frontier screen.
    if (current.exhausted || current.nextAction >= current.actions.length) {
      markExhausted(current);
      let frontier: CrawlNode | undefined;
      for (const node of crawlNodes) {
        if (node.exhausted || node.nextAction >= node.actions.length) continue;
        if (!frontier || node.depth < frontier.depth) frontier = node;
      }
      if (!frontier) break; // everything explored — done
      const ok = await replayTo(frontier, `backtracking to ${frontier.id}`);
      if (aborted()) {
        store.cancel();
        return "cancelled";
      }
      if (!ok) {
        // The path no longer reproduces this screen — give up on its
        // remaining actions rather than looping on a dead replay.
        markExhausted(frontier);
        continue;
      }
      current = frontier;
      continue;
    }

    const action = current.actions[current.nextAction]!;
    current.nextAction += 1;
    store.patchNode(current.id, { actionsExplored: current.nextAction });
    store.bumpStats({ actionsExplored: 1 });
    // Consuming the last action makes the node exhausted NOW — the loop may
    // descend and never stand on this node again, so don't wait for a revisit
    // to record it. (`current.exhausted` stays false so this iteration's own
    // control flow is untouched; the flag is for the store/graph.)
    if (current.nextAction >= current.actions.length) {
      store.patchNode(current.id, { exhausted: true });
    }
    emit({
      kind: "action",
      nodeId: current.id,
      label: action.label,
      explored: current.nextAction,
      total: current.actions.length,
    });

    const point = centreOf(action.frame);
    await driver.tap(point.x, point.y);
    await driver.awaitSettle();
    const tree = await readTree();

    if (tree === null) {
      // Left the app (home screen, another app, a browser). Record the edge
      // into the synthetic outside node, then get back on the map: foreground
      // the app first — it usually resumes exactly where we left it — and
      // only restart-replay when that resume lands elsewhere.
      store.addEdge(current.id, ensureOutsideNode(current.depth + 1), action);
      store.bumpStats({ restarts: 1 });
      emit({ kind: "restart", reason: "the tap left the app; relaunching" });
      await driver.launchApp();
      await driver.awaitSettle();
      const resumed = await readTree();
      if (!resumed || screenKey(resumed) !== current.key) {
        const ok = await replayTo(
          current,
          `app state lost after leaving; replaying to ${current.id}`
        );
        if (!ok && !aborted()) markExhausted(current);
      }
      continue;
    }

    const key = screenKey(tree);
    if (key === current.key) {
      // Same screen — the tap did nothing observable (or toggled dynamic
      // content the fingerprint deliberately ignores). No edge, no self-loop.
      continue;
    }

    const known = byKey.get(key);
    if (known) {
      // Revisit of an already-mapped screen: record the edge, then get back
      // to unexplored work — ideally `current`, or whatever known screen the
      // back navigation dropped us on.
      store.addEdge(current.id, known.id, action);
      const landed = await returnToCurrent(current, tree);
      if (aborted()) {
        store.cancel();
        return "cancelled";
      }
      if (landed) current = landed;
      else markExhausted(current);
      continue;
    }

    // A brand-new screen.
    const child = await createNode(tree, current.depth + 1, [...current.path, action]);
    store.addEdge(current.id, child.id, action);
    if (child.depth >= limits.maxDepth) {
      // Depth cap: record the screen but never descend into it.
      markExhausted(child);
      const landed = await returnToCurrent(current, tree);
      if (aborted()) {
        store.cancel();
        return "cancelled";
      }
      if (landed) current = landed;
      else markExhausted(current);
      continue;
    }
    current = child; // DFS descent
  }

  store.complete();
  return "completed";
}
