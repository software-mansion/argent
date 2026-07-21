import { describe, it, expect } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import type { MapCrawlLimits } from "../../src/tools/map/contract";
import { crawlApp, type CrawlDriver } from "../../src/tools/map/crawler";
import { MapSessionStore } from "../../src/utils/map-session";

function n(role: string, frame: [number, number, number, number], extra: Partial<DescribeNode> = {}, children: DescribeNode[] = []): DescribeNode {
  return { role, frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] }, children, ...extra } as DescribeNode;
}
function screenTree(name: string, buttonLabels: string[]): DescribeNode {
  return n("AXGroup", [0, 0, 1, 1], {}, [
    n("AXHeading", [0.1, 0.02, 0.8, 0.05], { label: name, identifier: `hdr-${name}` }),
    ...buttonLabels.map((label, i) => n("AXButton", [0.1, 0.2 + i * 0.12, 0.8, 0.08], { label, clickable: true })),
  ]);
}
type Transitions = Record<string, Record<string, string>>;
class FakeApp implements CrawlDriver {
  current: string; taps = 0; restartCount = 0; launchCount = 0; time = 0;
  private backStack: string[] = [];
  constructor(private screens: Record<string, DescribeNode>, public transitions: Transitions, private rootScreen: string, private platform: "ios" | "android" = "ios") { this.current = rootScreen; }
  async fetchTree() { return this.screens[this.current]!; }
  async tap(x: number, y: number) { this.taps += 1; const label = this.buttonAt(x, y); if (!label) return; const t = this.transitions[this.current]?.[label]; if (!t) return; this.backStack.push(this.current); this.current = t; }
  async pressBack() { if (this.platform !== "android") return false; const p = this.backStack.pop(); if (p) this.current = p; return true; }
  async restartApp() { this.restartCount += 1; this.current = this.rootScreen; this.backStack = []; }
  async launchApp() { this.launchCount += 1; }
  async isTargetForeground() { return true; }
  async openUrl() { return false; }
  async awaitSettle() {}
  async screenshot(id: string) { return `fake://${id}`; }
  now() { return this.time; }
  private buttonAt(x: number, y: number): string | null {
    let best: { label: string; area: number } | undefined;
    const walk = (node: DescribeNode) => { const f = node.frame; if (node.label && x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height && node.role === "AXButton") { const a = f.width * f.height; if (!best || a < best.area) best = { label: node.label, area: a }; } for (const c of node.children) walk(c); };
    walk(this.screens[this.current]!); return best?.label ?? null;
  }
}
const LIMITS: MapCrawlLimits = { maxScreens: 30, maxActionsPerScreen: 12, maxDepth: 5, timeBudgetMs: 300_000 };

describe("waste probe", () => {
  it("current spends its last action landing on a known-exhausted screen (iOS, no back btn)", async () => {
    const app = new FakeApp(
      { home: screenTree("Home", ["To A", "To B"]), a: screenTree("A", ["To Shared"]), b: screenTree("B", ["To Shared"]), shared: screenTree("Shared", []) },
      { home: { "To A": "a", "To B": "b" }, a: { "To Shared": "shared" }, b: { "To Shared": "shared" } },
      "home"
    );
    const store = new MapSessionStore();
    store.begin({ udid: "U", bundleId: "com.example.app", platform: "ios", limits: LIMITS, openWindow: false });
    await crawlApp({ driver: app, store, limits: LIMITS, platform: "ios", bundleId: "com.example.app" });
    const snap = store.snapshot();
    console.log("restartCount(app):", app.restartCount, "store.restarts:", snap.stats.restarts);
    console.log("nodes:", snap.nodes.map((x) => x.title));
    console.log("edges:", snap.edges.map((e) => [e.from, e.to, e.action.label]));
    expect(snap.nodes.map((x) => x.title).sort()).toEqual(["A", "B", "Home", "Shared"]);
  });
});
