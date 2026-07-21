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
  /**
   * Whether the app being crawled is actually on screen right now: true
   * (confidently in the foreground), false (confidently gone — a tap bounced us
   * to another app / the launcher / a browser), or null (can't tell). Optional:
   * drivers that cannot answer omit it and the crawler falls back to the tree's
   * own signals. The reliable "left the app" signal iOS otherwise lacks, since
   * its describe reads whichever app is frontmost rather than the target bundle.
   */
  isTargetForeground?(): Promise<boolean | null>;
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
  /**
   * Open a URL / deep link on the device. Resolves true when the open was
   * dispatched (the app may or may not foreground — the caller decides by
   * reading the tree afterwards); false when nothing handled it. Used to seed
   * additional entry points that no tap path reaches.
   */
  openUrl(url: string): Promise<boolean>;
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
  /**
   * Extra entry points to seed after the launch crawl. Each is opened via
   * `driver.openUrl`; a link reaching a new screen becomes a fresh entry the
   * crawl then explores, a link reaching a known screen just flags it an entry,
   * and a link that fails / leaves the app is skipped. All entries share the
   * one screen/time/depth budget.
   */
  deepLinks?: string[];
  signal?: AbortSignal;
  emitProgress?: (event: MapProgressEvent) => void;
}

// Internal crawl bookkeeping per screen (the store holds the wire-shaped
// node; this holds what traversal needs: the replay path and action cursor).
interface CrawlNode {
  id: string;
  key: string;
  // Live traversal depth (= `path.length`): the number of taps from this node's
  // entry to reach it. Drives the maxDepth budget and the shallowest-frontier
  // backtrack. INTERNAL only — the wire node has no depth (a screen is reachable
  // by many paths of differing length; depth is a traversal artifact, not a
  // property of the screen).
  depth: number;
  /**
   * How to get back to the start of `path`: `null` = the launch root, replay
   * from a fresh `restartApp`; a URL = a deep-link entry, replay by re-opening
   * that link. Descendants inherit their entry's origin, so restart-replay
   * backtracking works inside a deep-link-seeded subtree too.
   */
  entryUrl: string | null;
  /** First-discovery action path from this node's entry — the replay recipe. */
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

/** The non-framework resource-id packages present in a tree. Android
 * resource-ids are package-qualified (`com.pkg:id/name`); the `android:`
 * namespace is shared framework chrome and is excluded. */
export function collectResourcePackages(tree: DescribeNode): Set<string> {
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
  return packages;
}

/**
 * Android "left the app" detector. A tree whose resource-ids all belong to
 * OTHER packages is another app / the launcher.
 *
 * The app's own package is LEARNED from its in-app screens rather than assumed
 * from the launch bundle id, because the two legitimately differ: an
 * `applicationIdSuffix` build launches as `com.example.app.debug` while its
 * resource-ids stay namespaced `com.example.app`, so an exact bundle-id match
 * would flag every one of its own screens as "outside" and abort the crawl at
 * launch. The first screens carrying qualified ids seed the app's package set
 * (the root is reached before any tap, so it cannot be outside), and screens
 * sharing a known package grow it (multi-module apps span several namespaces).
 * A tree with no qualified ids is treated as still-in-app (Compose screens
 * often carry none). This resource-id tell is a FALLBACK: the primary "left the
 * app" signal is `driver.isTargetForeground()` (checked first in readTree),
 * which covers both the iOS case — where describe reads whichever app is
 * frontmost, so a foreign tree looks in-app and no resource-id heuristic applies
 * — and the Compose-app gap where this detector has no package to match on.
 */
export function makeOutsideDetector(platform: "ios" | "android"): (tree: DescribeNode) => boolean {
  const appPackages = new Set<string>();
  return (tree: DescribeNode): boolean => {
    if (platform !== "android") return false;
    const packages = collectResourcePackages(tree);
    if (packages.size === 0) return false;
    let sharesKnown = appPackages.size === 0;
    for (const p of packages) if (appPackages.has(p)) sharesKnown = true;
    if (sharesKnown) {
      for (const p of packages) appPackages.add(p);
      return false;
    }
    return true;
  };
}

/**
 * Crawl the app and record the screen graph into `store`. Resolves
 * "completed" (budgets/frontier exhausted) or "cancelled" (signal aborted —
 * the partial graph is kept and the store finalized as cancelled). Transient
 * device errors (a dropped tap, a flaky relaunch) degrade the affected step
 * rather than ending the run — the partial map survives. Rejects only on a
 * genuinely-hard failure (the app never became readable at launch →
 * MAP_APP_NOT_VISIBLE); the CALLER finalizes the store as failed then.
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
  // Stateful across the crawl: learns the app's own resource-id package(s) from
  // its in-app screens so a suffixed applicationId isn't misread as "outside".
  const looksOutside = makeOutsideDetector(platform);

  /**
   * Run one best-effort device action (a tap, a relaunch): a transient sub-tool
   * rejection — a dropped gesture, a flaky restart — must degrade the crawl, not
   * destroy it, so the caller keeps the partial map. Returns whether it landed;
   * an abort still rethrows so cancellation stays cancellation.
   */
  async function tryStep(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (aborted()) throw err;
      return false;
    }
  }

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
    // A non-empty tree can still belong to another app: iOS' describe reads
    // whichever app is frontmost, so a tap that opened Safari / Settings / the
    // share sheet returns that foreign app's tree looking perfectly in-app. Ask
    // the driver whether our target is actually on screen — this is the primary,
    // authoritative signal when it can answer:
    //   false → left the app (before the resource-id heuristic runs, so a foreign
    //           tree never seeds the Android package set and poisons later reads);
    //   true  → our own task is on top, so the tree IS in-app even when its only
    //           qualified ids belong to a third-party SDK (an embedded player /
    //           maps view) that the resource-id fallback would misread as foreign.
    // Only when it cannot tell (null) do we fall back to that heuristic.
    if (driver.isTargetForeground) {
      const foreground = await driver.isTargetForeground();
      if (foreground === false) return null;
      if (foreground === true) return tree;
    }
    return looksOutside(tree) ? null : tree;
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
    path: MapAction[],
    entry: boolean,
    entryUrl: string | null
  ): Promise<CrawlNode> {
    const key = screenKey(tree);
    const actions = enumerateActions(tree, { platform, maxActions: limits.maxActionsPerScreen });
    const stored = store.addNode({
      key,
      title: screenTitle(tree),
      entry,
      outside: false,
      actionsTotal: actions.length,
      screenshotPath: null,
    });
    const node: CrawlNode = {
      id: stored.id,
      key,
      depth,
      entryUrl,
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
  function ensureOutsideNode(): string {
    if (outsideNodeId !== null) return outsideNodeId;
    const stored = store.addNode({
      key: "__outside__",
      title: "Outside the app",
      entry: false,
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
   * Re-establish `target`'s entry so its `path` can be replayed: a launch root
   * restarts the app; a deep-link entry re-opens its link. False when the
   * primitive failed (or the deep link no longer foregrounds the app). An abort
   * mid-open rethrows so cancellation stays cancellation.
   */
  async function reopen(target: CrawlNode): Promise<boolean> {
    if (target.entryUrl === null) return tryStep(() => driver.restartApp());
    try {
      return await driver.openUrl(target.entryUrl);
    } catch (err) {
      if (aborted()) throw err;
      return false;
    }
  }

  /**
   * Re-establish `target`'s entry and replay its discovery path. True when we
   * land on a screen with `target`'s key; false on divergence (the path no
   * longer leads there — dynamic content moved, an interstitial appeared) or
   * abort.
   */
  async function replayTo(target: CrawlNode, reason: string): Promise<boolean> {
    store.bumpStats({ restarts: 1 });
    emit({ kind: "restart", reason });
    // A failed reopen just means we can't reach the target — a divergence the
    // callers already handle (mark the node exhausted), not a crawl-ending throw.
    if (!(await reopen(target))) return false;
    await driver.awaitSettle();
    for (const step of target.path) {
      // The deadline is also checked here, not only at the DFS loop top: a deep
      // replay is the crawl's most expensive step (restart + a tap/settle/read
      // per path element), so a budget that ran out mid-replay bails now with a
      // partial map instead of overrunning by the rest of the path.
      if (aborted() || overTime()) return false;
      const tree = await readTree();
      if (!tree) return false;
      const point = replayTapPoint(tree, step);
      if (!(await tryStep(() => driver.tap(point.x, point.y)))) return false;
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
      // A failed hardware-back press is not fatal: fall through to the
      // restart-replay below rather than tearing the whole crawl down.
      try {
        backTried = await driver.pressBack();
      } catch (err) {
        if (aborted()) throw err;
      }
    } else {
      const point = iosBackPoint(hereTree);
      if (point) backTried = await tryStep(() => driver.tap(point.x, point.y));
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
    // The back tap didn't land anywhere useful. If `current` is already spent it
    // owes no actions, so a restart-replay back to it — the most expensive step —
    // would only be undone by the next iteration's immediate backtrack. Signal the
    // caller (which will mark it exhausted) to drop straight to the frontier
    // backtrack rather than pay to stand on a screen with nothing left to do.
    if (current.nextAction >= current.actions.length) return null;
    const ok = await replayTo(
      current,
      `back navigation did not reach ${current.id}; replaying its path`
    );
    return ok ? current : null;
  }

  // ── Launch and root discovery ─────────────────────────────────────────
  // Restart, never resume: a plain launch foregrounds whatever screen a
  // previous session left the app on, and a crawl rooted in leftover state
  // walks backwards through a stack its replay can never re-enter. The
  // restart tools tolerate a not-running app.
  emit({ kind: "phase", message: `Restarting ${bundleId} for a clean crawl root` });
  // Best-effort: a failed restart doesn't reject on its own — the readTree gate
  // below decides. If the app is readable anyway the crawl proceeds; if not, it
  // is the genuinely-hard failure (MAP_APP_NOT_VISIBLE) the caller expects.
  await tryStep(() => driver.restartApp());
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
  const rootNode = await createNode(rootTree, 0, [], true, null);

  // ── DFS exploration from one entry ────────────────────────────────────
  // The depth-first walk, startable from any entry (the launch root or a
  // deep-link seed). It backtracks across the WHOLE frontier — every
  // unexhausted node, whatever entry it descends from — so a later entry's
  // walk naturally skips the earlier, already-exhausted subtrees. Resolves
  // "cancelled" (and finalizes the store) on abort, else "completed" when the
  // frontier empties or a shared budget (screens/time) is spent.
  async function explore(start: CrawlNode): Promise<"completed" | "cancelled"> {
    let current = start;
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
      // A dropped tap is a transient device hiccup, not a crawl-ender: skip this
      // action (it stays counted as attempted) and move on to the next.
      if (!(await tryStep(() => driver.tap(point.x, point.y)))) continue;
      await driver.awaitSettle();
      const tree = await readTree();

      if (tree === null) {
        // Left the app (home screen, another app, a browser). Record the edge
        // into the synthetic outside node, then get back on the map: foreground
        // the app first — it usually resumes exactly where we left it — and
        // only restart-replay when that resume lands elsewhere.
        store.addEdge(current.id, ensureOutsideNode(), action);
        store.bumpStats({ restarts: 1 });
        emit({ kind: "restart", reason: "the tap left the app; relaunching" });
        // Best-effort relaunch: if it fails, the readTree/replay recovery below
        // still runs (and can restart-replay us back onto the map).
        await tryStep(() => driver.launchApp());
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
        store.addEdge(current.id, known.id, action);
        // Revisit of an already-mapped screen. If it still has unexplored
        // actions, keep crawling from right here — we are already standing on
        // it, and `current`'s remaining actions stay owed to the frontier
        // backtrack.
        if (!known.exhausted && known.nextAction < known.actions.length) {
          current = known;
          continue;
        }
        // A screen first discovered at the depth cap is flagged exhausted with
        // its actions still owed (the only state in which an exhausted node
        // keeps owed actions). If this tap path reached it more shallowly and
        // that shorter depth is back inside the budget, re-root it here and
        // descend: depth is a traversal artifact, not a screen property, so a
        // shorter route revives the subtree the deep-first discovery had to drop
        // — the tap-path twin of the deep-link re-root below.
        const revisitDepth = current.depth + 1;
        if (
          known.exhausted &&
          known.nextAction < known.actions.length &&
          revisitDepth < known.depth &&
          revisitDepth < limits.maxDepth
        ) {
          known.depth = revisitDepth;
          known.path = [...current.path, action];
          known.entryUrl = current.entryUrl;
          known.exhausted = false;
          store.patchNode(known.id, { exhausted: false });
          current = known;
          continue;
        }
        // Only when the landed screen is spent is it worth paying navigation to
        // get back to `current`.
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
      const child = await createNode(
        tree,
        current.depth + 1,
        [...current.path, action],
        false,
        current.entryUrl
      );
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
    return "completed";
  }

  const rootOutcome = await explore(rootNode);
  if (rootOutcome === "cancelled") return "cancelled";

  // ── Deep-link seeding ─────────────────────────────────────────────────
  // Each deep link is a possible extra way into the app. After the launch
  // crawl, open each one and fingerprint where it lands: a NEW screen becomes
  // a fresh entry the crawl explores (its own depth-0 origin, replayable by
  // re-opening the link); a KNOWN screen is just flagged an entry (no fake edge
  // from the root — a deep link is a jump, not a tap); a link that fails to
  // open or leaves the app is skipped. All entries share the one budget.
  for (const url of opts.deepLinks ?? []) {
    if (aborted()) {
      store.cancel();
      return "cancelled";
    }
    if (overTime() || screens >= limits.maxScreens) {
      emit({ kind: "phase", message: "Budget spent — skipping the remaining deep links" });
      break;
    }
    emit({ kind: "phase", message: `Seeding deep link ${url}` });
    let opened: boolean;
    try {
      opened = await driver.openUrl(url);
    } catch {
      if (aborted()) {
        store.cancel();
        return "cancelled";
      }
      opened = false;
    }
    if (!opened) {
      emit({ kind: "phase", message: `Deep link ${url} could not be opened — skipping` });
      continue;
    }
    await driver.awaitSettle();
    const tree = await readTree();
    if (aborted()) {
      store.cancel();
      return "cancelled";
    }
    if (!tree) {
      emit({ kind: "phase", message: `Deep link ${url} did not foreground the app — skipping` });
      continue;
    }
    const key = screenKey(tree);
    const known = byKey.get(key);
    if (known) {
      // Already mapped — the deep link is another entrance to it.
      store.markEntry(known.id);
      if (known.nextAction < known.actions.length) {
        // …but it still owes actions: the launch crawl only recorded it (a
        // depth cap bottomed out there, or a spent budget) and never descended.
        // The deep link is a fresh depth-0 origin from which that subtree now
        // fits the budget — re-root the node here and explore it, instead of
        // dropping exactly the deep screens deep links exist to reach.
        known.depth = 0;
        known.path = [];
        known.entryUrl = url;
        if (known.exhausted) {
          known.exhausted = false;
          store.patchNode(known.id, { exhausted: false });
        }
        const outcome = await explore(known);
        if (outcome === "cancelled") return "cancelled";
      } else {
        emit({ kind: "phase", message: `Deep link ${url} reached the known screen ${known.id}` });
      }
      continue;
    }
    // A screen no tap path reached: a genuine new entry point. Explore it under
    // the shared budgets, replayable by re-opening this link.
    const entryNode = await createNode(tree, 0, [], true, url);
    const outcome = await explore(entryNode);
    if (outcome === "cancelled") return "cancelled";
  }

  store.complete();
  return "completed";
}
