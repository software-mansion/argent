import { describe, it, expect } from "vitest";
import type { Registry } from "@argent/registry";
import { buildRnPreviewTree } from "../../src/tools/describe/preview-rn-tree";
import type { DescribeNode } from "../../src/tools/describe/contract";

interface RnNode {
  i: number;
  p: number;
  n?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  t?: string;
  d?: string;
  l?: string;
}

// Fake Registry whose JsRuntimeDebugger service `cdp.evaluate` returns a
// canned RnResult JSON string (or simulates failure).
function fakeRegistry(
  behavior:
    | { kind: "result"; payload: unknown }
    | { kind: "resolve-throws" }
    | { kind: "non-string" }
): Registry {
  return {
    async resolveService<T>(): Promise<T> {
      if (behavior.kind === "resolve-throws") throw new Error("Metro not reachable");
      const value =
        behavior.kind === "non-string"
          ? 123
          : typeof behavior.payload === "string"
            ? behavior.payload
            : JSON.stringify(behavior.payload);
      return {
        deviceName: "iPhone",
        appName: "app",
        logicalDeviceId: "udid",
        cdp: {
          async evaluate() {
            return value;
          },
        },
      } as unknown as T;
    },
  } as unknown as Registry;
}

const SCREEN = { screenW: 400, screenH: 800 };

function find(node: DescribeNode, pred: (n: DescribeNode) => boolean): DescribeNode | null {
  if (pred(node)) return node;
  for (const c of node.children) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}

describe("buildRnPreviewTree", () => {
  it("builds a nested tree with normalized frames incl. non-accessibility containers", async () => {
    const nodes: RnNode[] = [
      { i: 0, p: -1, n: "ScrollView", x: 0, y: 0, w: 400, h: 800 },
      { i: 1, p: 0, n: "PokemonExploreEntry", x: 8, y: 100, w: 384, h: 90, d: "card-bulbasaur" },
      { i: 2, p: 1, n: "Text", x: 80, y: 120, w: 120, h: 24, t: "bulbasaur" },
    ];
    const res = await buildRnPreviewTree(
      fakeRegistry({ kind: "result", payload: { ...SCREEN, nodes } }),
      "udid",
      8081
    );
    expect(res).not.toBeNull();
    expect(res!.source).toBe("native-devtools");
    const root = res!.tree;
    expect(root.role).toBe("AXGroup");

    // The non-accessibility container must be present, anchored to its real
    // box (this is the whole point — it is NOT in the iOS ax tree).
    const card = find(root, (n) => n.identifier === "card-bulbasaur");
    expect(card).not.toBeNull();
    expect(card!.role).toBe("PokemonExploreEntry");
    expect(card!.frame.x).toBeCloseTo(8 / 400, 6);
    expect(card!.frame.y).toBeCloseTo(100 / 800, 6);
    expect(card!.frame.width).toBeCloseTo(384 / 400, 6);
    expect(card!.frame.height).toBeCloseTo(90 / 800, 6);

    // Nesting preserved via parent index: Text is a descendant of the card.
    const text = find(card!, (n) => n.value === "bulbasaur");
    expect(text).not.toBeNull();
    expect(text!.role).toBe("Text");
  });

  it("climbs through dropped/off-screen wrappers to the nearest surviving ancestor", async () => {
    const nodes: RnNode[] = [
      { i: 0, p: -1, n: "ScrollView", x: 0, y: 0, w: 400, h: 800 },
      // Off-screen wrapper (y way past the screen → clamps to zero area → dropped)
      { i: 1, p: 0, n: "Offscreen", x: 0, y: 9000, w: 400, h: 50 },
      { i: 2, p: 1, n: "Text", x: 10, y: 20, w: 50, h: 10, t: "hi" },
    ];
    const res = await buildRnPreviewTree(
      fakeRegistry({ kind: "result", payload: { ...SCREEN, nodes } }),
      "udid"
    );
    const root = res!.tree;
    const sv = find(root, (n) => n.role === "ScrollView")!;
    expect(find(root, (n) => n.role === "Offscreen")).toBeNull();
    // Text reparented onto ScrollView, not flattened to the synthetic root.
    expect(find(sv, (n) => n.value === "hi")).not.toBeNull();
    expect(root.children.some((c) => c.value === "hi")).toBe(false);
  });

  it("drops off-screen and zero-area nodes", async () => {
    const nodes: RnNode[] = [
      { i: 0, p: -1, n: "View", x: 0, y: 0, w: 400, h: 800 },
      { i: 1, p: 0, n: "Scrolled", x: 0, y: 6653, w: 266, h: 22, t: "bulbasaur" },
      { i: 2, p: 0, n: "Zero", x: 5, y: 5, w: 0, h: 50 },
    ];
    const res = await buildRnPreviewTree(
      fakeRegistry({ kind: "result", payload: { ...SCREEN, nodes } }),
      "udid"
    );
    const root = res!.tree;
    expect(find(root, (n) => n.role === "Scrolled")).toBeNull();
    expect(find(root, (n) => n.role === "Zero")).toBeNull();
  });

  it("returns null (caller falls back) when the debugger is unreachable", async () => {
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "resolve-throws" }), "udid")).toBeNull();
  });

  it("returns null on a script error / non-string result", async () => {
    expect(
      await buildRnPreviewTree(
        fakeRegistry({ kind: "result", payload: { error: "no-fabric" } }),
        "udid"
      )
    ).toBeNull();
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "non-string" }), "udid")).toBeNull();
  });

  it("returns null when no node yields a usable on-screen rect (no regression vs ax fallback)", async () => {
    const nodes: RnNode[] = [
      { i: 0, p: -1, n: "View", x: 0, y: 9000, w: 10, h: 10 },
      { i: 1, p: 0, n: "Text", x: 0, y: 9100, w: 0, h: 0, t: "x" },
    ];
    expect(
      await buildRnPreviewTree(
        fakeRegistry({ kind: "result", payload: { ...SCREEN, nodes } }),
        "udid"
      )
    ).toBeNull();
  });

  it("ignores non-object array elements without throwing (defense-in-depth)", async () => {
    const nodes = [
      null,
      { i: 0, p: -1, n: "View", x: 0, y: 0, w: 400, h: 800 },
      undefined,
      { i: 1, p: 0, n: "Text", x: 10, y: 20, w: 80, h: 20, t: "hi" },
    ];
    const res = await buildRnPreviewTree(
      fakeRegistry({ kind: "result", payload: { ...SCREEN, nodes } }),
      "udid"
    );
    expect(res).not.toBeNull();
    expect(find(res!.tree, (n) => n.value === "hi")).not.toBeNull();
  });
});
