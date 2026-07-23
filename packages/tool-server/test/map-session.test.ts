import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";
import { MapSessionStore } from "../src/utils/map-session";
import type { MapAction, MapCrawlLimits } from "../src/tools/map/contract";

const LIMITS: MapCrawlLimits = {
  maxScreens: 30,
  maxActionsPerScreen: 12,
  maxDepth: 5,
  timeBudgetMs: 300_000,
};

function begin(store: MapSessionStore, openWindow = false): { crawlId: string } {
  return store.begin({
    udid: "TEST-UDID",
    bundleId: "com.example.app",
    platform: "ios",
    limits: LIMITS,
    openWindow,
  });
}

const action = (label = "Go"): MapAction => ({
  label,
  role: "AXButton",
  selector: { by: "label", value: label },
  frame: { x: 0.1, y: 0.2, w: 0.8, h: 0.08 },
});

const nodeInput = (over: Partial<Parameters<MapSessionStore["addNode"]>[0]> = {}) => ({
  key: "key-0",
  title: "Home" as string | null,
  entry: false,
  outside: false,
  actionsTotal: 2,
  screenshotPath: null,
  ...over,
});

describe("MapSessionStore — session lifecycle", () => {
  it("begin opens a running session and returns a crawl id", () => {
    const s = new MapSessionStore();
    expect(s.snapshot().status).toBe("idle");
    const { crawlId } = begin(s, true);
    expect(crawlId).toMatch(/[0-9a-f-]{36}/);
    expect(s.sessionScreenshotDir()).toContain(crawlId);
    const snap = s.snapshot();
    expect(snap.status).toBe("running");
    expect(snap.udid).toBe("TEST-UDID");
    expect(snap.bundleId).toBe("com.example.app");
    expect(snap.platform).toBe("ios");
    expect(snap.limits).toEqual(LIMITS);
    expect(snap.stats).toMatchObject({ screens: 0, edges: 0, actionsExplored: 0, restarts: 0 });
    expect(snap.startedAt).not.toBeNull();
    expect(snap.finishedAt).toBeNull();
    expect(s.sessionScreenshotDir()).toMatch(/argent-map/);
    expect(s.openWindowRequested()).toBe(true);
  });

  it("begin while a crawl is running throws MAP_CRAWL_ALREADY_RUNNING", () => {
    const s = new MapSessionStore();
    begin(s);
    let thrown: unknown;
    try {
      begin(s);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/already running/);
    expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.MAP_CRAWL_ALREADY_RUNNING);
    // The running session was not disturbed.
    expect(s.snapshot().status).toBe("running");
  });

  it("a new begin after finalize resets the previous graph and mints a new session dir", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput());
    s.complete();
    const firstDir = s.sessionScreenshotDir();

    begin(s);
    const snap = s.snapshot();
    expect(snap.status).toBe("running");
    expect(snap.nodes).toEqual([]);
    expect(snap.edges).toEqual([]);
    expect(snap.entryPoints).toEqual([]);
    expect(snap.error).toBeNull();
    expect(s.sessionScreenshotDir()).not.toBe(firstDir);
  });

  it("finalize is a one-way, running-only transition (complete/cancel/fail)", () => {
    const s = new MapSessionStore();
    begin(s);
    s.complete();
    expect(s.snapshot().status).toBe("completed");
    expect(s.snapshot().finishedAt).not.toBeNull();
    // A late fail/cancel (e.g. the tool's defensive finally) must not regress.
    s.fail("too late");
    s.cancel();
    expect(s.snapshot().status).toBe("completed");
    expect(s.snapshot().error).toBeNull();

    begin(s);
    s.fail("boom");
    const snap = s.snapshot();
    expect(snap.status).toBe("failed");
    expect(snap.error).toBe("boom");

    begin(s);
    s.cancel();
    expect(s.snapshot().status).toBe("cancelled");
  });

  it("isCrawlRunning tracks the running state (the window-close guard reads it)", () => {
    // onSelectionSubmitted (index.ts) suppresses the Lens window's auto-close
    // while this is true, so a variant submit can't tear down a live crawl's
    // Map window. Pin the predicate it depends on across the lifecycle.
    const s = new MapSessionStore();
    expect(s.isCrawlRunning()).toBe(false); // idle
    begin(s);
    expect(s.isCrawlRunning()).toBe(true);
    s.complete();
    expect(s.isCrawlRunning()).toBe(false);
    begin(s);
    s.cancel();
    expect(s.isCrawlRunning()).toBe(false);
    begin(s);
    s.fail("boom");
    expect(s.isCrawlRunning()).toBe(false);
  });

  it("emits mapSessionChanged(true) on begin and (false) exactly once on finalize", () => {
    const s = new MapSessionStore();
    const seen: boolean[] = [];
    s.events.on("mapSessionChanged", (active) => seen.push(active));
    begin(s);
    s.complete();
    s.cancel(); // guarded no-op — must not re-emit
    expect(seen).toEqual([true, false]);
  });

  it("begin sweeps stale orphan screenshot dirs (crashed tool-servers) but spares recent ones", () => {
    // begin() only ever knew its own previous dir, so a crashed/restarted
    // process leaks one dir per crawl under argent-map/. Point tmpdir at a
    // sandbox and seed one aged-out orphan next to a fresh (active) sibling.
    const realTmp = process.env.TMPDIR;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "map-sweep-"));
    process.env.TMPDIR = sandbox;
    try {
      const parent = path.join(sandbox, "argent-map");
      const stale = path.join(parent, "stale-crawl");
      const fresh = path.join(parent, "fresh-crawl");
      for (const dir of [stale, fresh]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "s0.png"), "x");
      }
      // Age the orphan two hours into the past (past the one-hour threshold).
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);

      begin(new MapSessionStore());

      expect(fs.existsSync(stale)).toBe(false); // swept — no live process owns it
      expect(fs.existsSync(fresh)).toBe(true); // spared — mtime is recent
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmp;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("begin spares an aged dir a live tool-server still owns, reaps a dead owner's", () => {
    // Dirs are named `<ownerPid>-<crawlId>`. A finished map keeps being served
    // (its dir mtime frozen) long after the crawl ended, so age alone would let
    // a concurrent server delete a live owner's thumbnails. The owner-pid check
    // spares any dir a running process owns and reaps only exited processes'.
    const realTmp = process.env.TMPDIR;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "map-sweep-owner-"));
    process.env.TMPDIR = sandbox;
    try {
      const parent = path.join(sandbox, "argent-map");
      const live = path.join(parent, `${process.pid}-live`); // this (running) process
      const dead = path.join(parent, "2147483646-dead"); // a pid past any real one
      for (const dir of [live, dead]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "s0.png"), "x");
      }
      // Age BOTH two hours past the one-hour cutoff — only ownership differs.
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(live, old, old);
      fs.utimesSync(dead, old, old);

      begin(new MapSessionStore());

      expect(fs.existsSync(live)).toBe(true); // live owner keeps its finished-map thumbnails
      expect(fs.existsSync(dead)).toBe(false); // exited owner's leftover reaped
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmp;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("MapSessionStore — graph mutations", () => {
  it("addNode mints ids in discovery order, tracks entry points, counts screens (outside excluded)", () => {
    const s = new MapSessionStore();
    begin(s);
    // The launch screen is an entry; a plain tap-reached screen is not; the
    // synthetic outside node is neither an entry nor counted.
    const first = s.addNode(nodeInput({ entry: true }));
    const second = s.addNode(nodeInput({ key: "key-1" }));
    const outside = s.addNode(nodeInput({ key: "__outside__", outside: true, title: "Outside" }));

    expect(first.id).toBe("s0");
    expect(second.id).toBe("s1");
    expect(outside.id).toBe("s2");
    const snap = s.snapshot();
    // entryPoints holds exactly the entry nodes, in discovery order.
    expect(snap.entryPoints).toEqual(["s0"]);
    expect(snap.nodes.map((n) => n.entry)).toEqual([true, false, false]);
    expect(snap.stats.screens).toBe(2); // outside not counted
    expect(snap.nodes[0]!.discoveredAt).toBeGreaterThan(0);
  });

  it("a second entry node (a deep-link seed) appends to entryPoints in discovery order", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput({ entry: true })); // launch
    s.addNode(nodeInput({ key: "key-1" })); // tap-reached, not an entry
    s.addNode(nodeInput({ key: "key-2", title: "Settings", entry: true })); // deep-link seed
    expect(s.snapshot().entryPoints).toEqual(["s0", "s2"]);
  });

  it("markEntry flags an existing node as an entry; it is idempotent and ignores unknown ids", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput({ entry: true })); // launch s0
    s.addNode(nodeInput({ key: "key-1", title: "Detail" })); // tap-reached s1
    expect(s.snapshot().entryPoints).toEqual(["s0"]);

    // A deep link lands on the already-recorded s1 → it becomes an entry too,
    // with no duplicate node.
    s.markEntry("s1");
    expect(s.snapshot().nodes[1]!.entry).toBe(true);
    expect(s.snapshot().entryPoints).toEqual(["s0", "s1"]);
    expect(s.snapshot().nodes).toHaveLength(2);

    // Repeat calls and unknown ids never duplicate or throw.
    s.markEntry("s1");
    s.markEntry("s0"); // already an entry
    s.markEntry("nope");
    expect(s.snapshot().entryPoints).toEqual(["s0", "s1"]);
  });

  it("addNode falls back to 'Screen N' when no title was derived", () => {
    const s = new MapSessionStore();
    begin(s);
    expect(s.addNode(nodeInput({ title: null })).title).toBe("Screen 1");
    expect(s.addNode(nodeInput({ key: "key-1", title: "  " })).title).toBe("Screen 2");
    expect(s.addNode(nodeInput({ key: "key-2", title: "Profile" })).title).toBe("Profile");
  });

  it("addEdge mints ids and counts edges", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput());
    s.addNode(nodeInput({ key: "key-1" }));
    const edge = s.addEdge("s0", "s1", action("To A"));
    expect(edge.id).toBe("e0");
    expect(s.snapshot().stats.edges).toBe(1);
    expect(s.snapshot().edges[0]).toMatchObject({ from: "s0", to: "s1" });
  });

  it("patchNode updates a node; unknown ids are ignored", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput());
    s.patchNode("s0", { actionsExplored: 2, exhausted: true, screenshotPath: "/tmp/x.png" });
    s.patchNode("s99", { exhausted: true });
    const node = s.snapshot().nodes[0]!;
    expect(node.actionsExplored).toBe(2);
    expect(node.exhausted).toBe(true);
    expect(node.screenshotPath).toBe("/tmp/x.png");
  });

  it("bumpStats is additive", () => {
    const s = new MapSessionStore();
    begin(s);
    s.bumpStats({ actionsExplored: 1 });
    s.bumpStats({ actionsExplored: 1, restarts: 1 });
    expect(s.snapshot().stats).toMatchObject({ actionsExplored: 2, restarts: 1 });
  });

  it("screenshotPathFor resolves recorded paths and null otherwise", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput({ screenshotPath: "/tmp/shot.png" }));
    s.addNode(nodeInput({ key: "key-1" }));
    expect(s.screenshotPathFor("s0")).toBe("/tmp/shot.png");
    expect(s.screenshotPathFor("s1")).toBeNull();
    expect(s.screenshotPathFor("nope")).toBeNull();
  });
});

describe("MapSessionStore — snapshot isolation", () => {
  it("mutating a snapshot never corrupts the store", () => {
    const s = new MapSessionStore();
    begin(s);
    s.addNode(nodeInput());
    s.addEdge("s0", "s0", action());

    const snap = s.snapshot();
    snap.nodes.push({ ...snap.nodes[0]!, id: "s99" });
    snap.nodes[0]!.title = "Hacked";
    snap.edges[0]!.action.label = "Hacked";
    snap.edges[0]!.action.selector.value = "Hacked";
    snap.stats.screens = 999;
    snap.limits!.maxScreens = 999;

    const clean = s.snapshot();
    expect(clean.nodes).toHaveLength(1);
    expect(clean.nodes[0]!.title).toBe("Home");
    expect(clean.edges[0]!.action.label).toBe("Go");
    expect(clean.edges[0]!.action.selector.value).toBe("Go");
    expect(clean.stats.screens).toBe(1);
    expect(clean.limits!.maxScreens).toBe(LIMITS.maxScreens);
  });

  it("addNode returns a copy and addEdge deep-copies the caller's action", () => {
    const s = new MapSessionStore();
    begin(s);
    const returned = s.addNode(nodeInput());
    returned.title = "Mutated";
    expect(s.snapshot().nodes[0]!.title).toBe("Home");

    const callerAction = action("Original");
    s.addNode(nodeInput({ key: "key-1" }));
    s.addEdge("s0", "s1", callerAction);
    callerAction.label = "Mutated";
    callerAction.frame.x = 0.999;
    expect(s.snapshot().edges[0]!.action.label).toBe("Original");
    expect(s.snapshot().edges[0]!.action.frame.x).toBe(0.1);
  });

  it("elapsedMs is live while running and frozen after finalize", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(1_000_000));
      const s = new MapSessionStore();
      begin(s);
      vi.setSystemTime(new Date(1_005_000));
      expect(s.snapshot().stats.elapsedMs).toBe(5_000);
      s.complete();
      vi.setSystemTime(new Date(1_060_000));
      expect(s.snapshot().stats.elapsedMs).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
