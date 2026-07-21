import { describe, it, expect } from "vitest";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";
import type { DescribeNode } from "../src/tools/describe/contract";
import type { MapCrawlLimits } from "../src/tools/map/contract";
import {
  crawlApp,
  makeOutsideDetector,
  collectResourcePackages,
  type CrawlDriver,
} from "../src/tools/map/crawler";
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

// An Android screen whose widgets carry package-qualified resource-ids.
function androidScreen(pkg: string, ids: string[]): DescribeNode {
  return n(
    "android.widget.FrameLayout",
    [0, 0, 1, 1],
    {},
    ids.map((idName, i) =>
      n("android.widget.TextView", [0.1, 0.1 + i * 0.1, 0.8, 0.06], {
        identifier: `${pkg}:id/${idName}`,
      })
    )
  );
}

describe("makeOutsideDetector — Android left-the-app tell", () => {
  it("keeps a suffixed applicationId in-app: its resource namespace differs from the launch id", () => {
    // The regression: launch id com.example.app.debug, resource namespace
    // com.example.app. An exact bundle-id compare flagged every own screen as
    // outside and aborted the crawl at launch.
    const looksOutside = makeOutsideDetector("android");
    // Root defines the app's package set (it cannot be outside).
    expect(looksOutside(androidScreen("com.example.app", ["root"]))).toBe(false);
    // Later own screens keep matching by the learned namespace, not the id.
    expect(looksOutside(androidScreen("com.example.app", ["detail"]))).toBe(false);
  });

  it("flags a foreign-package screen as outside, then re-admits the app on return", () => {
    const looksOutside = makeOutsideDetector("android");
    expect(looksOutside(androidScreen("com.example.app", ["home"]))).toBe(false);
    expect(looksOutside(androidScreen("com.android.launcher3", ["workspace"]))).toBe(true);
    expect(looksOutside(androidScreen("com.example.app", ["home"]))).toBe(false);
  });

  it("learns additional in-app namespaces from screens that share a known one", () => {
    // A multi-module app: a screen carrying BOTH the app package and a library
    // package teaches the detector the library package too, so a later
    // library-only screen is still in-app.
    const looksOutside = makeOutsideDetector("android");
    expect(looksOutside(androidScreen("com.example.app", ["root"]))).toBe(false);
    const mixed = n("android.widget.FrameLayout", [0, 0, 1, 1], {}, [
      n("android.widget.TextView", [0.1, 0.1, 0.8, 0.06], {
        identifier: "com.example.app:id/host",
      }),
      n("android.widget.TextView", [0.1, 0.2, 0.8, 0.06], {
        identifier: "com.example.lib:id/widget",
      }),
    ]);
    expect(looksOutside(mixed)).toBe(false);
    expect(looksOutside(androidScreen("com.example.lib", ["widget"]))).toBe(false);
  });

  it("treats a tree with no qualified ids (Compose) as in-app, and ignores android: chrome", () => {
    const looksOutside = makeOutsideDetector("android");
    const compose = n("android.view.View", [0, 0, 1, 1], {}, [
      n("android.widget.TextView", [0.1, 0.1, 0.8, 0.06], { identifier: "android:id/statusBar" }),
    ]);
    expect(looksOutside(compose)).toBe(false);
    expect(collectResourcePackages(compose).size).toBe(0);
  });

  it("is inert on iOS — the foreground check, not package identity, signals leaving there", () => {
    // iOS describe reads whichever app is frontmost, so a resource-id namespace
    // tell is meaningless; readTree relies on driver.isTargetForeground instead.
    const looksOutside = makeOutsideDetector("ios");
    expect(looksOutside(androidScreen("com.other.app", ["x"]))).toBe(false);
  });
});

type Transitions = Record<string, Record<string, string>>;

class FakeApp implements CrawlDriver {
  current: string;
  taps = 0;
  restartCount = 0;
  launchCount = 0;
  openUrlCount = 0;
  time = 0;
  onTap?: (tapNumber: number) => void;
  onRestart?: () => void;
  /**
   * Deep-link routing: url → the screen it opens onto. The special target
   * "outside" models a link that opens but doesn't foreground the app (e.g. an
   * iOS Universal Link → Safari). A url absent from this map "fails to open".
   */
  deepLinks: Record<string, string> = {};
  /**
   * Screens that render a perfectly readable, non-empty tree but belong to
   * ANOTHER app — a tap that opened Safari / the share sheet / Settings. Unlike
   * "outside" (fetchTree throws), these read as in-app to the tree itself; only
   * `isTargetForeground` tells them apart. Models the real iOS trap where AX
   * describe returns whichever app is frontmost.
   */
  foreignScreens = new Set<string>();
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
    if (target === "outside" || this.foreignScreens.has(target)) {
      // Left the app: "outside" reads as a throw, a foreign screen reads as a
      // full tree — either way the app is no longer frontmost, so launchApp
      // must bring us back to where we were.
      this.resumeOnLaunch = this.current;
      this.current = target;
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
    if (this.current === "outside" || this.foreignScreens.has(this.current)) {
      this.current = this.resumeOnLaunch;
    }
  }

  async isTargetForeground(): Promise<boolean | null> {
    if (this.current === "outside") return false; // fetchTree also throws here
    return this.foreignScreens.has(this.current) ? false : true;
  }

  async openUrl(url: string): Promise<boolean> {
    this.openUrlCount += 1;
    const target = this.deepLinks[url];
    if (target === undefined) return false; // nothing handled the link
    // A fresh entrance resets the back stack (the link jumps straight in), the
    // same way a restart does — so a deep-link subtree's replay is deterministic.
    this.backStack = [];
    this.current = target; // "outside" is a valid target: opened, not foregrounded
    return true;
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
  extra: { signal?: AbortSignal; platform?: "ios" | "android"; deepLinks?: string[] } = {}
): Promise<"completed" | "cancelled"> {
  return crawlApp({
    driver: app,
    store,
    limits: { ...LIMITS, ...overrides },
    platform: extra.platform ?? "ios",
    bundleId: "com.example.app",
    deepLinks: extra.deepLinks,
    signal: extra.signal,
  });
}

describe("crawlApp — graph discovery", () => {
  it("maps a small app: nodes, entry flags, edges, titles, screenshots, dedup by structure", async () => {
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
    // The launch screen is the sole entry point; nothing carries a wire depth.
    expect(snap.entryPoints).toEqual(["s0"]);
    expect(snap.nodes[0]).not.toHaveProperty("depth");
    expect(snap.nodes.map((x) => ({ title: x.title, entry: x.entry }))).toEqual([
      { title: "Home", entry: true },
      { title: "Screen A", entry: false },
      { title: "Screen B", entry: false },
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

describe("crawlApp — deep-link seeding (multiple entry points)", () => {
  it("entryPoints starts empty, then holds only the launch screen after a plain crawl", async () => {
    const app = new FakeApp({ home: screenTree("Home", []) }, {}, "home");
    const store = makeStore();
    // Before any screen is recorded, there are no entry points.
    expect(store.snapshot().entryPoints).toEqual([]);
    await crawl(app, store);
    const snap = store.snapshot();
    expect(snap.entryPoints).toEqual(["s0"]);
    expect(snap.nodes[0]!.entry).toBe(true);
    expect(snap.nodes[0]).not.toHaveProperty("depth"); // wire node carries no depth
  });

  it("a deep link reaching a NEW screen adds an entry node, records it in entryPoints, and explores it", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A"]),
        a: screenTree("Screen A", []),
        settings: screenTree("Settings", ["To Prefs"]),
        prefs: screenTree("Prefs", []),
      },
      { home: { "To A": "a" }, settings: { "To Prefs": "prefs" } },
      "home"
    );
    app.deepLinks = { "myapp://settings": "settings" };
    const store = makeStore();
    const result = await crawl(app, store, {}, { deepLinks: ["myapp://settings"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // Launch crawl found Home + Screen A; the deep link seeded Settings and the
    // crawl explored it, discovering its child Prefs.
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A", "Settings", "Prefs"]);
    const settings = snap.nodes.find((x) => x.title === "Settings")!;
    const prefs = snap.nodes.find((x) => x.title === "Prefs")!;
    // The launch screen and the deep-link screen are BOTH entry points.
    expect(snap.entryPoints).toEqual(["s0", settings.id]);
    expect(settings.entry).toBe(true);
    expect(prefs.entry).toBe(false);
    // A deep link is a jump, not a tap — no fake edge from the root into it…
    expect(snap.edges.some((e) => e.from === "s0" && e.to === settings.id)).toBe(false);
    // …but the seeded entry WAS explored: its own edge to Prefs exists.
    expect(snap.edges.some((e) => e.from === settings.id && e.to === prefs.id)).toBe(true);
    expect(app.openUrlCount).toBe(1);
  });

  it("a deep link reaching a KNOWN screen flags it an entry without duplicating a node or an edge", async () => {
    const app = new FakeApp(
      { home: screenTree("Home", ["To A"]), a: screenTree("Screen A", []) },
      { home: { "To A": "a" } },
      "home"
    );
    app.deepLinks = { "myapp://a": "a" };
    const store = makeStore();
    // The same link twice proves markEntry / entryPoints never duplicates.
    const result = await crawl(app, store, {}, { deepLinks: ["myapp://a", "myapp://a"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // Screen A was already discovered by tapping — no second node is created.
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
    const a = snap.nodes.find((x) => x.title === "Screen A")!;
    expect(a.entry).toBe(true);
    expect(snap.entryPoints).toEqual(["s0", a.id]); // A appears once despite two links
    // The deep link added no edge — only the tap-discovered Home → Screen A.
    expect(snap.edges).toHaveLength(1);
    expect(snap.edges[0]).toMatchObject({ from: "s0", to: a.id });
  });

  it("a deep link onto a DEPTH-CAPPED known screen explores the subtree the cap dropped", async () => {
    // Launch crawl bottoms out at maxDepth: Home(0) → A(1) → S(2, capped —
    // recorded but never descended, so its "To T" action is owed). The deep link
    // lands back on S as a fresh depth-0 origin; T (one tap from that entry, in
    // budget) must now be discovered — the whole reason deep links exist.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A"]),
        a: screenTree("Screen A", ["To S"]),
        s: screenTree("Screen S", ["To T"]),
        t: screenTree("Screen T", []),
      },
      { home: { "To A": "a" }, a: { "To S": "s" }, s: { "To T": "t" } },
      "home"
    );
    app.deepLinks = { "myapp://s": "s" };
    const store = makeStore();
    const result = await crawl(app, store, { maxDepth: 2 }, { deepLinks: ["myapp://s"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // Without the fix, S is capped and flagged an entry but T is never reached.
    expect(snap.nodes.some((x) => x.title === "Screen S")).toBe(true);
    expect(snap.nodes.some((x) => x.title === "Screen T")).toBe(true);
    const s = snap.nodes.find((x) => x.title === "Screen S")!;
    expect(s.entry).toBe(true);
    // The subtree edge S → T was recorded by the re-exploration.
    const t = snap.nodes.find((x) => x.title === "Screen T")!;
    expect(snap.edges.some((e) => e.from === s.id && e.to === t.id)).toBe(true);
  });

  it("a deep link that fails to open or leaves the app is skipped, and the crawl still completes", async () => {
    const app = new FakeApp(
      { home: screenTree("Home", ["To A"]), a: screenTree("Screen A", []) },
      { home: { "To A": "a" } },
      "home"
    );
    // "myapp://web" opens but does not foreground the app (blank tree read);
    // "myapp://gone" is handled by nothing (openUrl resolves false).
    app.deepLinks = { "myapp://web": "outside" };
    const store = makeStore();
    const result = await crawl(app, store, {}, { deepLinks: ["myapp://web", "myapp://gone"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    expect(snap.status).toBe("completed");
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
    expect(snap.entryPoints).toEqual(["s0"]); // only the launch entry
    // A skipped deep link creates no node (not even the synthetic outside one).
    expect(snap.nodes.some((x) => x.outside)).toBe(false);
    expect(app.openUrlCount).toBe(2); // both were attempted
  });

  it("explores a deep-link subtree by re-opening the link to backtrack (a restart would land on the root)", async () => {
    // The launch screen is a dead end; the real content sits behind a deep link
    // with two dead-end children reached by separate taps. After the first, the
    // crawler must backtrack to the deep-link entry — reachable ONLY by
    // re-opening the link, since a restart would foreground Home instead.
    const app = new FakeApp(
      {
        home: screenTree("Home", []),
        d: screenTree("Deep", ["To D1", "To D2"]),
        d1: screenTree("Deep One", []),
        d2: screenTree("Deep Two", []),
      },
      { d: { "To D1": "d1", "To D2": "d2" } },
      "home"
    );
    app.deepLinks = { "myapp://deep": "d" };
    const store = makeStore();
    const result = await crawl(app, store, {}, { deepLinks: ["myapp://deep"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // Both children of the deep-link entry were discovered.
    expect(snap.nodes.map((x) => x.title).sort()).toEqual(["Deep", "Deep One", "Deep Two", "Home"]);
    const d = snap.nodes.find((x) => x.title === "Deep")!;
    expect(d.entry).toBe(true);
    expect(snap.entryPoints).toEqual(["s0", d.id]);
    // Backtracking re-opened the link (seed + at least one replay) and never
    // restarted the app after the clean-root launch restart.
    expect(app.openUrlCount).toBeGreaterThanOrEqual(2);
    expect(app.restartCount).toBe(1);
  });

  it("shares the screen budget across entries: a spent budget skips deep-link seeding entirely", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A"]),
        a: screenTree("Screen A", []),
        settings: screenTree("Settings", []),
      },
      { home: { "To A": "a" } },
      "home"
    );
    app.deepLinks = { "myapp://settings": "settings" };
    const store = makeStore();
    // maxScreens=2 is filled by the launch crawl (Home + Screen A), so the deep
    // link is never opened.
    const result = await crawl(app, store, { maxScreens: 2 }, { deepLinks: ["myapp://settings"] });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    expect(snap.stats.screens).toBe(2);
    expect(snap.nodes.map((x) => x.title)).toEqual(["Home", "Screen A"]);
    expect(snap.entryPoints).toEqual(["s0"]);
    expect(app.openUrlCount).toBe(0); // budget spent before any deep link
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

  it("treats a tap into another app (non-empty foreign tree) as leaving, not a screen", async () => {
    // The real iOS trap: describe reads whichever app is frontmost, so a tap
    // that opens Safari / Settings / the share sheet hands back a full,
    // in-app-looking tree. Only isTargetForeground tells it apart — without it
    // the crawler would map the foreign screen and DFS-descend into it, burning
    // the screen/time budget mapping another app.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Open link", "To A"]),
        safari: screenTree("Safari — example.com", ["Address bar", "Reload"]),
        a: screenTree("Screen A", []),
      },
      { home: { "Open link": "safari", "To A": "a" } },
      "home"
    );
    app.foreignScreens.add("safari"); // reads as a full tree, but it is Safari
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    // Safari is NOT a mapped screen — it was recorded as leaving the app.
    expect(snap.nodes.some((x) => x.title.startsWith("Safari"))).toBe(false);
    const outside = snap.nodes.find((x) => x.outside)!;
    expect(outside).toBeDefined();
    expect(snap.edges.some((e) => e.from === "s0" && e.to === outside.id)).toBe(true);
    expect(snap.stats.restarts).toBeGreaterThanOrEqual(1);
    expect(app.launchCount).toBeGreaterThanOrEqual(1);
    // Recovered onto the map and still explored the sibling path.
    expect(snap.nodes.some((x) => x.title === "Screen A")).toBe(true);
  });

  it("a foreground signal of null (driver can't tell) keeps the tree — no spurious exit", async () => {
    // When the driver cannot answer (getAppState down / non-RN app), a readable
    // tree is still trusted: the crawl must not invent an outside edge.
    const app = new FakeApp(
      { home: screenTree("Home", ["To A"]), a: screenTree("Screen A", []) },
      { home: { "To A": "a" } },
      "home"
    );
    app.isTargetForeground = async () => null;
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();
    expect(snap.nodes.some((x) => x.outside)).toBe(false);
    expect(snap.nodes.some((x) => x.title === "Screen A")).toBe(true);
    expect(snap.stats.restarts).toBe(0);
  });

  it("Android: a confident in-app foreground keeps an SDK-namespaced screen the resource-id tell would drop", async () => {
    // An in-app screen whose only qualified ids belong to a third-party SDK
    // (an embedded player / maps view) — foreign to the learned app package, so
    // the resource-id fallback flags it "outside". But our own task is on top
    // (isTargetForeground === true), so it must be mapped, not dropped.
    const home = n("android.widget.FrameLayout", [0, 0, 1, 1], {}, [
      n("AXHeading", [0.1, 0.02, 0.8, 0.05], {
        label: "Home",
        identifier: "com.example.app:id/root",
      }),
      n("AXButton", [0.1, 0.2, 0.8, 0.08], {
        label: "Open player",
        clickable: true,
        identifier: "com.example.app:id/open",
      }),
    ]);
    const sdk = n("android.widget.FrameLayout", [0, 0, 1, 1], {}, [
      n("AXHeading", [0.1, 0.02, 0.8, 0.05], {
        label: "Player",
        identifier: "com.google.android.exoplayer2:id/exo_content",
      }),
    ]);
    const app = new FakeApp({ home, sdk }, { home: { "Open player": "sdk" } }, "home", "android");
    const store = makeStore("android");
    await crawl(app, store, {}, { platform: "android" });
    const snap = store.snapshot();
    // The SDK screen is mapped, and no spurious "outside" edge/relaunch fired.
    expect(snap.nodes.some((x) => x.title === "Player")).toBe(true);
    expect(snap.nodes.some((x) => x.outside)).toBe(false);
    expect(snap.stats.restarts).toBe(0);
  });
});

describe("crawlApp — replay and backtracking", () => {
  it("does not restart-replay back to a spent current when its last tap lands on an exhausted screen", async () => {
    // Home's two branches reconverge on a dead-end Shared screen; no back
    // buttons, so returning anywhere costs a restart-replay. When the SECOND
    // branch's last tap (B → Shared) lands on the already-mapped Shared, B is
    // itself spent — restarting back to B would map nothing, so it must be
    // skipped. The full graph is still discovered, with one fewer restart.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", ["To Shared"]),
        b: screenTree("Screen B", ["To Shared"]),
        shared: screenTree("Shared", []),
      },
      {
        home: { "To A": "a", "To B": "b" },
        a: { "To Shared": "shared" },
        b: { "To Shared": "shared" },
      },
      "home"
    );
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // Correctness unaffected: every screen and both reconverging edges are mapped.
    expect(snap.nodes.map((x) => x.title).sort()).toEqual([
      "Home",
      "Screen A",
      "Screen B",
      "Shared",
    ]);
    const shared = snap.nodes.find((x) => x.title === "Shared")!;
    const a = snap.nodes.find((x) => x.title === "Screen A")!;
    const b = snap.nodes.find((x) => x.title === "Screen B")!;
    expect(snap.edges.some((e) => e.from === a.id && e.to === shared.id)).toBe(true);
    expect(snap.edges.some((e) => e.from === b.id && e.to === shared.id)).toBe(true);
    // The wasted replay-to-spent-B is gone: launch + the one real backtrack only.
    expect(app.restartCount).toBeLessThanOrEqual(2);
  });

  it("re-roots a depth-capped screen reached again by a shorter tap path and explores its subtree", async () => {
    // Screen B is reachable deep (Home→A→B, landing at the depth cap) and
    // shallow (Home→B, one tap). Discovered deep first, B is recorded at the cap
    // with its "Go C" action owed; the shorter Home→B revisit must re-root B
    // inside the budget so Screen C — two taps from the root, within maxDepth —
    // is not dropped purely because of Home's button order. (The tap-path twin
    // of the deep-link re-root exercised above.)
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Go A", "Go B"]),
        a: screenTree("Screen A", ["Go B"]),
        b: screenTree("Screen B", ["Go C"]),
        c: screenTree("Screen C", []),
      },
      {
        home: { "Go A": "a", "Go B": "b" },
        a: { "Go B": "b" },
        b: { "Go C": "c" },
      },
      "home"
    );
    const store = makeStore();
    await crawl(app, store, { maxDepth: 2 });
    const snap = store.snapshot();

    expect(snap.nodes.map((x) => x.title).sort()).toEqual([
      "Home",
      "Screen A",
      "Screen B",
      "Screen C",
    ]);
    const home = snap.nodes.find((x) => x.title === "Home")!;
    const b = snap.nodes.find((x) => x.title === "Screen B")!;
    const c = snap.nodes.find((x) => x.title === "Screen C")!;
    // The shorter Home→B edge and the revived B→C edge both exist.
    expect(snap.edges.some((e) => e.from === home.id && e.to === b.id)).toBe(true);
    expect(snap.edges.some((e) => e.from === b.id && e.to === c.id)).toBe(true);
  });

  it("adopts the shorter depth when revisiting a non-exhausted known screen, keeping its owed subtree in budget", async () => {
    // Screen X is discovered deep (Home→A→X, depth 2) with an owed action left
    // pending, then reached again by the direct Home→X link (depth 1). Exploring
    // X's owed "To W" from the stale deep depth would push the W→U→T chain over
    // maxDepth and drop Screen T; adopting the shorter depth on revisit keeps the
    // whole reachable chain — depth is a traversal artifact, not a screen property.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To X"]),
        a: screenTree("Screen A", ["To X"]),
        x: screenTree("Screen X", ["To Y", "To W"]),
        y: screenTree("Screen Y", []),
        w: screenTree("Screen W", ["To U"]),
        u: screenTree("Screen U", ["To T"]),
        t: screenTree("Screen T", []),
      },
      {
        home: { "To A": "a", "To X": "x" },
        a: { "To X": "x" },
        x: { "To Y": "y", "To W": "w" },
        w: { "To U": "u" },
        u: { "To T": "t" },
      },
      "home"
    );
    const store = makeStore();
    await crawl(app, store, { maxDepth: 4 });
    const snap = store.snapshot();

    expect(snap.nodes.map((n) => n.title).sort()).toEqual([
      "Home",
      "Screen A",
      "Screen T",
      "Screen U",
      "Screen W",
      "Screen X",
      "Screen Y",
    ]);
    const u = snap.nodes.find((n) => n.title === "Screen U")!;
    const t = snap.nodes.find((n) => n.title === "Screen T")!;
    expect(snap.edges.some((e) => e.from === u.id && e.to === t.id)).toBe(true);
  });

  it("revives an exhausted-with-owed screen when a later tap lands back on it in budget", async () => {
    // Screen A owes "To Z" but gets marked exhausted when a replay can't get back
    // to it (its recorded path diverges). Later, tapping "To A" from Screen B
    // lands directly on A again — we are standing on it, so its owed "To Z" (and
    // Screen Z, reachable only through it) must still be explored, even though A
    // is not reached by a shorter path. A replay-abandoned screen is not
    // permanently dead once we are back on it within budget.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To M", "To A", "To B"]),
        m: screenTree("Screen M", []),
        a: screenTree("Screen A", ["Revisit M", "To Z"]),
        b: screenTree("Screen B", ["To A"]),
        z: screenTree("Screen Z", []),
        decoy: screenTree("Decoy", []),
      },
      {
        home: { "To M": "m", "To A": "a", "To B": "b" },
        a: { "Revisit M": "m", "To Z": "z" },
        b: { "To A": "a" },
      },
      "home"
    );
    // Once A has been discovered and the crawler tries to replay back to it, the
    // launch screen's "To A" diverts to a decoy — so returnToCurrent(A) fails and
    // A is marked exhausted with "To Z" still owed. (Restarts 1-2 are the clean
    // root and the frontier replay that first reaches A, which must stay intact.)
    app.onRestart = () => {
      if (app.restartCount >= 3) app.transitions.home!["To A"] = "decoy";
    };
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    // Screen Z (reachable only through A's owed "To Z") is recovered, not lost.
    const a = snap.nodes.find((x) => x.title === "Screen A")!;
    const z = snap.nodes.find((x) => x.title === "Screen Z");
    expect(z).toBeDefined();
    expect(snap.edges.some((e) => e.from === a.id && e.to === z!.id)).toBe(true);
    expect(a.exhausted).toBe(true); // fully explored by the end
  });

  it("records a tap-discovered screen's parent edge atomically with the node (before its screenshot)", async () => {
    // The screenshot await is the only yield between adding the node and adding
    // its parent edge, so a preview poll served during it must still see the
    // edge — otherwise the UI strands the child as a disconnected entry-island.
    const app = new FakeApp(
      { home: screenTree("Home", ["To A"]), a: screenTree("Screen A", []) },
      { home: { "To A": "a" } },
      "home"
    );
    const store = makeStore();
    // Snapshot the edge count at the instant each node's screenshot is captured.
    const edgesAtShot: Record<string, number> = {};
    const realScreenshot = app.screenshot.bind(app);
    app.screenshot = async (nodeId: string): Promise<string | null> => {
      edgesAtShot[nodeId] = store.snapshot().edges.length;
      return realScreenshot(nodeId);
    };
    await crawl(app, store);
    const snap = store.snapshot();

    const a = snap.nodes.find((n) => n.title === "Screen A")!;
    expect(snap.edges.some((e) => e.to === a.id)).toBe(true);
    // When A's screenshot was taken, its Home→A edge already existed (0 without
    // the atomic-edge fix, since the edge was added only after createNode returned).
    expect(edgesAtShot[a.id]).toBeGreaterThanOrEqual(1);
  });

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
    // After the first RECOVERY restart the app changes: "To A" now leads to
    // X, so the recorded path to A no longer reproduces it. (Restart #1 is
    // the clean-root restart at launch — the app must still be pristine
    // then, or A is never discovered at all.)
    app.onRestart = () => {
      if (app.restartCount >= 2) app.transitions.home!["To A"] = "x";
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
    // Exactly one recovery restart: A's "Revisit" tap lands on Home, which
    // still has "To B" pending, so the crawler continues from there for free;
    // the only restart is the frontier backtrack to A — the one that diverges.
    expect(snap.stats.restarts).toBe(1);
    expect(snap.status).toBe("completed");
  });

  it("continues from a revisited screen that still has work, with no navigation at all", async () => {
    // home → a, then a's tap lands back on home while home still has "To B"
    // pending: the crawler must simply keep exploring home from where it
    // stands — no back tap, no restart — and still discover B.
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", ["To Home"]),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" }, a: { "To Home": "home" } },
      "home"
    );
    const store = makeStore();
    await crawl(app, store);
    const snap = store.snapshot();

    expect(snap.nodes.map((x) => x.title).sort()).toEqual(["Home", "Screen A", "Screen B"]);
    expect(
      snap.edges.some((e) => e.from === "s1" && e.to === "s0" && e.action.label === "To Home")
    ).toBe(true);
    expect(snap.stats.restarts).toBe(0);
    expect(app.restartCount).toBe(1); // only the clean-root restart at launch
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
    app.launchApp = async () => {}; // neither launch...
    app.restartApp = async () => {}; // ...nor the clean-root restart helps
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

describe("crawlApp — resilience to transient device errors", () => {
  it("a dropped action tap is skipped, and the crawl keeps its partial map", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", []),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" } },
      "home"
    );
    const realTap = app.tap.bind(app);
    let taps = 0;
    app.tap = async (x, y) => {
      taps += 1;
      if (taps === 1) throw new Error("gesture-tap: device busy"); // the "To A" tap
      return realTap(x, y);
    };
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    expect(result).toBe("completed");
    expect(snap.status).toBe("completed");
    // "To A" was dropped; the crawl carried on and still discovered B.
    expect(snap.nodes.some((x) => x.title === "Screen B")).toBe(true);
    expect(snap.nodes.some((x) => x.title === "Screen A")).toBe(false);
  });

  it("a transient restart rejection during backtracking degrades to a partial map", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A", "To B"]),
        a: screenTree("Screen A", []),
        b: screenTree("Screen B", []),
      },
      { home: { "To A": "a", "To B": "b" } },
      "home"
    );
    const realRestart = app.restartApp.bind(app);
    let restarts = 0;
    app.restartApp = async () => {
      restarts += 1;
      if (restarts === 2) throw new Error("restart-app: connection reset"); // the backtrack
      return realRestart();
    };
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // The clean-root restart succeeded (Home + A mapped); the backtrack restart
    // failed, so Home's "To B" was abandoned rather than crashing the crawl.
    expect(snap.nodes.map((x) => x.title)).toContain("Home");
    expect(snap.nodes.map((x) => x.title)).toContain("Screen A");
    expect(snap.nodes.some((x) => x.title === "Screen B")).toBe(false);
  });

  it("a failed relaunch after leaving the app recovers via restart-replay", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["Open Web", "To A"]),
        a: screenTree("Screen A", []),
      },
      { home: { "Open Web": "outside", "To A": "a" } },
      "home"
    );
    app.launchApp = async () => {
      throw new Error("launch-app: device not responding");
    };
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    expect(result).toBe("completed");
    // The failed relaunch fell through to restart-replay; the crawl continued.
    expect(snap.nodes.some((x) => x.outside)).toBe(true);
    expect(snap.nodes.some((x) => x.title === "Screen A")).toBe(true);
  });

  it("a failed clean-root restart still crawls when the app is already readable", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A"]),
        a: screenTree("Screen A", []),
      },
      { home: { "To A": "a" } },
      "home"
    );
    const realRestart = app.restartApp.bind(app);
    let restarts = 0;
    app.restartApp = async () => {
      restarts += 1;
      if (restarts === 1) throw new Error("restart-app: transient"); // the clean-root restart
      return realRestart();
    };
    const store = makeStore();
    const result = await crawl(app, store);
    const snap = store.snapshot();

    // The launch restart failed, but the app was already on Home and readable —
    // the readTree gate lets the crawl proceed instead of MAP_APP_NOT_VISIBLE.
    expect(result).toBe("completed");
    expect(snap.nodes.map((x) => x.title)).toContain("Home");
    expect(snap.nodes.map((x) => x.title)).toContain("Screen A");
  });
});

describe("crawlApp — deadline enforcement", () => {
  it("bails mid-replay when the time budget runs out inside a deep backtrack", async () => {
    const app = new FakeApp(
      {
        home: screenTree("Home", ["To A"]),
        a: screenTree("Screen A", ["To B"]),
        b: screenTree("Screen B", ["To C", "To E"]),
        c: screenTree("Screen C", ["To Deep"]),
        deep: screenTree("Screen Deep", []),
        e: screenTree("Screen E", []),
      },
      {
        home: { "To A": "a" },
        a: { "To B": "b" },
        b: { "To C": "c", "To E": "e" },
        c: { "To Deep": "deep" },
      },
      "home"
    );
    // Each tap costs 100s. Discovery to the dead end is 4 taps (400s), under the
    // 450s budget, so the loop-top check passes and the backtrack to B starts.
    // Replaying B's path [To A, To B] would cost another 200s — the mid-replay
    // deadline check must bail after the first replay step (500s), not run the
    // whole path to 600s.
    app.onTap = () => {
      app.time += 100_000;
    };
    const store = makeStore();
    const result = await crawl(app, store, { timeBudgetMs: 450_000 });
    const snap = store.snapshot();

    expect(result).toBe("completed");
    expect(app.time).toBe(500_000); // bailed one step into the replay, not two
    expect(app.taps).toBe(5);
    // B's remaining action was never reached, so E stays undiscovered (partial).
    expect(snap.nodes.some((x) => x.title === "Screen E")).toBe(false);
  });
});
