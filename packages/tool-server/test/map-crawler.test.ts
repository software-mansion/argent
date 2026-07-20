import { describe, it, expect } from "vitest";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";
import type { DescribeNode } from "../src/tools/describe/contract";
import type { MapCrawlLimits } from "../src/tools/map/contract";
import { crawlApp, type CrawlDriver } from "../src/tools/map/crawler";
import { MapSessionStore } from "../src/utils/map-session";

// ── Synthetic app ──────────────────────────────────────────────────────────
// Screens are describe trees; transitions map "tap on the button labelled X on
// screen S" to a target screen (or "outside" — the tap left the app). A button
// with no transition entry is a no-op tap (same screen). Each screen's heading
// carries a unique identifier so structurally-similar screens keep distinct
// fingerprints (screenKey ignores labels but includes identifiers).

function n(
  role: string,
  frame: [number, number, number, number],
  extra: Partial<DescribeNode> = {},
  children: DescribeNode[] = []
): DescribeNode {
  return {
    role,
    frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
    children,
    ...extra,
  };
}

function screenTree(name: string, buttonLabels: string[]): DescribeNode {
  return n("AXGroup", [0, 0, 1, 1], {}, [
    n("AXHeading", [0.1, 0.02, 0.8, 0.05], { label: name, identifier: `hdr-${name}` }),
    ...buttonLabels.map((label, i) =>
      n("AXButton", [0.1, 0.2 + i * 0.12, 0.8, 0.08], { label, clickable: true })
    ),
  ]);
}

type Transitions = Record<string, Record<string, string>>;

class FakeApp implements CrawlDriver {
  current: string;
  taps = 0;
  restartCount = 0;
  launchCount = 0;
  time = 0;
  onTap?: (tapNumber: number) => void;
  onRestart?: () => void;
  private backStack: string[] = [];
  private resumeOnLaunch: string;

  constructor(
    private screens: Record<string, DescribeNode>,
    public transitions: Transitions,
    private rootScreen: string,
    private platform: "ios" | "android" = "ios"
  ) {
    this.current = rootScreen;
    this.resumeOnLaunch = rootScreen;
  }

  async fetchTree(): Promise<DescribeNode> {
    if (this.current === "outside") throw new Error("app is not in the foreground");
    return this.screens[this.current]!;
  }

  async tap(x: number, y: number): Promise<void> {
    this.taps += 1;
    this.onTap?.(this.taps);
    if (this.current === "outside") return;
    const label = this.buttonAt(x, y);
    if (!label) return;
    const target = this.transitions[this.current]?.[label];
    if (!target) return; // no-op tap
    if (target === "outside") {
      this.resumeOnLaunch = this.current;
      this.current = "outside";
      return;
    }
    this.backStack.push(this.current);
    this.current = target;
  }

  async pressBack(): Promise<boolean> {
    if (this.platform !== "android") return false;
    const prev = this.backStack.pop();
    if (prev) this.current = prev;
    return true;
  }

  async restartApp(): Promise<void> {
    this.restartCount += 1;
    this.onRestart?.();
    this.current = this.rootScreen;
    this.backStack = [];
  }

  async launchApp(): Promise<void> {
    this.launchCount += 1;
    if (this.current === "outside") this.current = this.resumeOnLaunch;
  }

  async awaitSettle(): Promise<void> {}

  async screenshot(nodeId: string): Promise<string | null> {
    return `fake://screenshot/${nodeId}`;
  }

  now(): number {
    return this.time;
  }

  private buttonAt(x: number, y: number): string | null {
    let best: { label: string; area: number } | undefined;
    const walk = (node: DescribeNode): void => {
      const f = node.frame;
      if (
        node.label &&
        x >= f.x &&
        x <= f.x + f.width &&
        y >= f.y &&
        y <= f.y + f.height &&
        node.role === "AXButton"
      ) {
        const area = f.width * f.height;
        if (!best || area < best.area) best = { label: node.label, area };
      }
      for (const child of node.children) walk(child);
    };
    walk(this.screens[this.current]!);
    return best === undefined ? null : best.label;
  }
}

const LIMITS: MapCrawlLimits = {
  maxScreens: 30,
  maxActionsPerScreen: 12,
  maxDepth: 5,
  timeBudgetMs: 300_000,
};

function makeStore(platform: "ios" | "android" = "ios"): MapSessionStore {
  const store = new MapSessionStore();
  store.begin({
    udid: "TEST-UDID",
    bundleId: "com.example.app",
    platform,
    limits: LIMITS,
    openWindow: false,
  });
  return store;
}

async function crawl(
  app: FakeApp,
  store: MapSessionStore,
  overrides: Partial<MapCrawlLimits> = {},
  extra: { signal?: AbortSignal; platform?: "ios" | "android" } = {}
): Promise<"completed" | "cancelled"> {
  return crawlApp({
    driver: app,
    store,
    limits: { ...LIMITS, ...overrides },
    platform: extra.platform ?? "ios",
    bundleId: "com.example.app",
    signal: extra.signal,
  });
}

describe("crawlApp — graph discovery", () => {
  it("maps a small app: nodes, depths, edges, titles, screenshots, dedup by structure", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", []),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" } },
      "home"
    );
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    expect(result).toBe("completed");
    expect(snap.status).toBe("completed");
    expect(snap.rootId).toBe("s0");
    expect(snap.nodes.map((x) => ({ title: x.title, depth: x.depth }))).toEqual([
      { title: "Home", depth: 0 },
      { title: "Screen A", depth: 1 },
      { title: "Screen B", depth: 1 },
    ]);
    expect(snap.edges.map((e) => [e.from, e.to, e.action.label])).toEqual([
      ["s0", "s1", "To A"],
      ["s0", "s2", "To B"],
    ]);
    expect(snap.stats.screens).toBe(3);
    expect(snap.stats.edges).toBe(2);
    // Backtracking from the dead-end A to finish Home = one restart-replay.
    expect(snap.stats.restarts).toBe(1);
    expect(snap.nodes.every((x) => x.exhausted)).toBe(true);
    expect(snap.nodes.every((x) => x.screenshotPath === `fake://screenshot/${x.id}`)).toBe(true);
  });

  it("same-screen taps record no edge and no node", async () => {
    const app = new FakeApp({ home: screenTree("Home", ["Noop"]) }, { home: {} }, "home");
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    expect(snap.nodes).toHaveLength(1);
    expect(snap.edges).toHaveLength(0);
    // The tap was still attempted and counted.
    expect(snap.stats.actionsExplored).toBe(1);
    expect(snap.nodes[0]!.actionsExplored).toBe(1);
    expect(snap.status).toBe("completed");
  });

  it("dedups revisits: two paths into one screen make one node and two edges", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["A1", "A2"]),
        a: screenTree("Screen A", []),
      },
      { home: { A1: "a", A2: "a" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges.map((e) => [e.from, e.to])).toEqual([
      ["s0", "s1"],
      ["s0", "s1"],
    ]);
  });
});

describe("crawlApp — budgets", () => {
  it("honors maxScreens", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Next"]),
        a: screenTree("Screen A", ["Deeper"]),
        b: screenTree("Screen B", []),
      },
      { home: { Next: "a" }, a: { Deeper: "b" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store, { maxScreens: 2 });
    const snap = store.snapshot();

    expect(snap.status).toBe("completed");
    expect(snap.stats.screens).toBe(2);
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
  });

  it("honors maxDepth: the capped screen is recorded but marked exhausted, never descended into", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Next"]),
        a: screenTree("Screen A", ["Deeper"]),
        b: screenTree("Screen B", []),
      },
      { home: { Next: "a" }, a: { Deeper: "b" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store, { maxDepth: 1 });
    const snap = store.snapshot();

    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
    const a = snap.nodes[1]!;
    expect(a.exhausted).toBe(true);
    expect(a.actionsTotal).toBe(1);
    expect(a.actionsExplored).toBe(0); // never tapped into
  });

  it("honors the time budget: stops with a partial map once the clock runs out", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", []),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" } },
      "home"
    );
    app.onTap = () => {
      app.time += 400_000; // first tap blows the 300s budget
    };
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    expect(snap.status).toBe("completed");
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
    const home = snap.nodes[0]!;
    expect(home.actionsExplored).toBe(1);
    expect(home.actionsTotal).toBe(2);
    // Ran out of budget, not out of actions — honestly not exhausted.
    expect(home.exhausted).toBe(false);
  });
});

describe("crawlApp — leaving the app", () => {
  it("records the synthetic outside node and relaunches back onto the map", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Open Web", "To A"]),
        a: screenTree("Screen A", []),
      },
      { home: { "Open Web": "outside", "To A": "a" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    const outside = snap.nodes.find((x) => x.outside)!;
    expect(outside).toBeDefined();
    expect(outside.title).toBe("Outside the app");
    expect(outside.exhausted).toBe(true);
    expect(outside.actionsTotal).toBe(0);
    expect(snap.edges.some((e) => e.from === "s0" && e.to === outside.id)).toBe(true);
    // The outside node is not a screen of the app.
    expect(snap.stats.screens).toBe(2);
    expect(snap.stats.restarts).toBeGreaterThanOrEqual(1);
    // The crawl continued after the exit: "To A" was still explored.
    expect(snap.nodes.some((x) => x.title === "Screen A")).toBe(true);
    expect(app.launchCount).toBeGreaterThanOrEqual(1); // the resume relaunch
  });
});

describe("crawlApp — replay and backtracking", () => {
  it("marks a node exhausted when its replay diverges, and keeps crawling the rest", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", ["Revisit", "To C"]),
        b: screenTree("Screen B", []),
        c: screenTree("Screen C", []),
        x: screenTree("Screen X", []),
      },
      { home: { "To A": "a", "To B": "b" }, a: { "Revisit": "home", "To C": "c" } },
      "home"
    );
    // After the first restart the app changes: "To A" now leads to X, so the
    // recorded path to A no longer reproduces it.
    app.onRestart = () => {
      app.transitions.home!["To A"] = "x";
    };
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    const a = snap.nodes.find((x) => x.title === "Screen A")!;
    expect(a.exhausted).toBe(true);
    expect(a.actionsExplored).toBe(1); // "Revisit" ran; "To C" was abandoned
    expect(a.actionsTotal).toBe(2);
    // C is unreachable once A's replay diverged; X was only seen mid-replay
    // and never recorded as a node.
    expect(snap.nodes.some((x) => x.title === "Screen C")).toBe(false);
    expect(snap.nodes.some((x) => x.title === "Screen X")).toBe(false);
    // B was still discovered after the divergence.
    expect(snap.nodes.some((x) => x.title === "Screen B")).toBe(true);
    expect(snap.stats.restarts).toBeGreaterThanOrEqual(2);
    expect(snap.status).toBe("completed");
  });

  it("iOS: adopts the known screen the back tap landed on instead of restarting", async () => {
    // Closing a sheet drops to its presenter, not to the page the crawler
    // asked to return to. When the landed screen still has unexplored
    // actions the crawler must continue from there — a restart-replay per
    // sheet would eat the whole time budget (observed live on Settings).
    const b = n("AXGroup", [0, 0, 1, 1], {}, [
      n("AXHeading", [0.1, 0.02, 0.8, 0.05], { label: "Screen B", identifier: "hdr-B" }),
      n("AXButton", [0.02, 0.03, 0.1, 0.04], { label: "Back" }),
    ]);
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To C"]),
        a: screenTree("Screen A", ["To B"]),
        b,
        c: screenTree("Screen C", []),
      },
      { home: { "To A": "a", "To C": "c" }, a: { "To B": "b" }, b: { Back: "home" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store, { maxDepth: 2 });
    const snap = store.snapshot();

    // B hit the depth cap; the Back tap landed on Home (known, work left),
    // which was adopted — so C was still discovered with zero restarts.
    expect(snap.nodes.map((x) => x.title).sort()).toEqual([
      "Home",
      "Screen A",
      "Screen B",
      "Screen C",
    ]);
    expect(snap.edges).toHaveLength(3);
    expect(snap.stats.restarts).toBe(0);
    expect(app.restartCount).toBe(1); // only the clean-root restart at launch
    expect(snap.status).toBe("completed");
  });

  it("Android: returns from a revisited screen via hardware back without restarting", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["A1", "A2"]),
        a: screenTree("Screen A", []),
      },
      { home: { A1: "a", A2: "a" } },
      "home",
      "android"
    );
    const store = makeStore("android");
    await crawl(app, store, {}, { platform: "android" });
    const snap = store.snapshot();

    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(2);
    // First dead-end backtrack needs one restart-replay; the second revisit
    // returns via pressBack, so no further restart happens. (The app-level
    // count is one higher: the clean-root restart at launch.)
    expect(snap.stats.restarts).toBe(1);
    expect(app.restartCount).toBe(2);
  });
});

describe("crawlApp — cancellation and failure", () => {
  it("abort mid-crawl finalizes as cancelled with the partial graph kept, and resolves", async () => {
    const controller = new AbortController();
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", []),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" } },
      "home"
    );
    app.onTap = (tapNumber) => {
      if (tapNumber === 2) controller.abort();
    };
    const store = makeStore();
    const result = await crawl(app, store, {}, { signal: controller.signal });
    const snap = store.snapshot();

    expect(result).toBe("cancelled");
    expect(snap.status).toBe("cancelled");
    expect(snap.nodes.length).toBeGreaterThanOrEqual(2); // partial graph kept
  });

  it("an already-aborted signal cancels before any device interaction", async () => {
    const controller = new AbortController();
    controller.abort();
    const app = new FakeApp({ home: screenTree("Home", []) }, {}, "home");
    const store = makeStore();
    // launch/settle may run, but the loop's first abort check must cancel —
    // and a rejected sub-call must convert to "cancelled", never a throw.
    const result = await crawl(app, store, {}, { signal: controller.signal });
    expect(result).toBe("cancelled");
    expect(store.snapshot().status).toBe("cancelled");
  });

  it("rejects with MAP_APP_NOT_VISIBLE when the app never becomes readable", async () => {
    const app = new FakeApp({ home: screenTree("Home", []) }, {}, "home");
    app.current = "outside"; // fetchTree always throws
    app.launchApp = async () => {}; // launch does not bring it back
    const store = makeStore();

    await expect(crawl(app, store)).rejects.toThrow(/never became readable/);
    // The crawler rejects; the TOOL finalizes the store as failed — so here
    // the store is still running and the caller contract applies.
    expect(store.snapshot().status).toBe("running");
    try {
      await crawl(app, store);
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.MAP_APP_NOT_VISIBLE);
    }
  });
});
