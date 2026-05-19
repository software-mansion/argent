import { describe, it, expect } from "vitest";
import type { Registry } from "@argent/registry";
import { buildRnPreviewTree } from "../../src/tools/describe/preview-rn-tree";
import type { RawResult } from "../../src/tools/debugger/debugger-component-tree";
import type { DescribeNode } from "../../src/tools/describe/contract";

// Minimal fake Registry whose JsRuntimeDebugger service evaluates the
// component-tree script to a canned RawResult (or simulates failure).
function fakeRegistry(
  behavior:
    | { kind: "raw"; raw: RawResult | string }
    | { kind: "resolve-throws" }
    | { kind: "non-string" }
): Registry {
  return {
    async resolveService<T>(): Promise<T> {
      if (behavior.kind === "resolve-throws") {
        throw new Error("Metro not reachable");
      }
      const result =
        behavior.kind === "non-string"
          ? 123
          : typeof behavior.raw === "string"
            ? behavior.raw
            : JSON.stringify(behavior.raw);
      return {
        deviceName: "iPhone",
        appName: "app",
        logicalDeviceId: "udid",
        cdp: {
          async evaluateWithBinding() {
            return { result };
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
    const raw: RawResult = {
      ...SCREEN,
      components: [
        { id: 0, name: "ScrollView", parentIdx: -1, rect: { x: 0, y: 0, w: 400, h: 800 } },
        {
          id: 1,
          name: "View",
          parentIdx: 0,
          rect: { x: 8, y: 100, w: 384, h: 90 },
          testID: "pokemon-card-bulbasaur",
        },
        {
          id: 2,
          name: "Text",
          parentIdx: 1,
          rect: { x: 80, y: 120, w: 120, h: 24 },
          text: "bulbasaur",
        },
      ],
    };
    const res = await buildRnPreviewTree(fakeRegistry({ kind: "raw", raw }), "udid", 8081);
    expect(res).not.toBeNull();
    expect(res!.source).toBe("native-devtools");
    const root = res!.tree;
    expect(root.role).toBe("AXGroup");

    // The non-accessibility container View must be present and anchored to
    // its real box (this is the whole point — it is NOT in the ax tree).
    const card = find(root, (n) => n.identifier === "pokemon-card-bulbasaur");
    expect(card).not.toBeNull();
    expect(card!.role).toBe("View");
    expect(card!.frame.x).toBeCloseTo(8 / 400, 6);
    expect(card!.frame.y).toBeCloseTo(100 / 800, 6);
    expect(card!.frame.width).toBeCloseTo(384 / 400, 6);
    expect(card!.frame.height).toBeCloseTo(90 / 800, 6);

    // Nesting preserved via parentIdx: Text is a descendant of the card.
    const text = find(card!, (n) => n.value === "bulbasaur");
    expect(text).not.toBeNull();
    expect(text!.role).toBe("Text");
  });

  it("climbs through skipped/no-rect wrappers to the nearest surviving ancestor", async () => {
    const raw: RawResult = {
      ...SCREEN,
      components: [
        { id: 0, name: "ScrollView", parentIdx: -1, rect: { x: 0, y: 0, w: 400, h: 800 } },
        { id: 1, name: "ContextProvider", parentIdx: 0, rect: null }, // dropped
        { id: 2, name: "Text", parentIdx: 1, rect: { x: 10, y: 20, w: 50, h: 10 }, text: "hi" },
      ],
    };
    const res = await buildRnPreviewTree(fakeRegistry({ kind: "raw", raw }), "udid");
    const root = res!.tree;
    const sv = find(root, (n) => n.role === "ScrollView")!;
    // Text reparented onto ScrollView (its no-rect parent was dropped), not
    // flattened to the synthetic root.
    expect(find(sv, (n) => n.value === "hi")).not.toBeNull();
    expect(root.children.some((c) => c.value === "hi")).toBe(false);
  });

  it("skips null-rect and zero-area entries", async () => {
    const raw: RawResult = {
      ...SCREEN,
      components: [
        { id: 0, name: "View", parentIdx: -1, rect: { x: 0, y: 0, w: 400, h: 800 } },
        { id: 1, name: "Ghost", parentIdx: 0, rect: null },
        { id: 2, name: "Zero", parentIdx: 0, rect: { x: 5, y: 5, w: 0, h: 50 } },
      ],
    };
    const res = await buildRnPreviewTree(fakeRegistry({ kind: "raw", raw }), "udid");
    const root = res!.tree;
    expect(find(root, (n) => n.role === "Ghost")).toBeNull();
    expect(find(root, (n) => n.role === "Zero")).toBeNull();
  });

  it("returns null (caller falls back) when the debugger is unreachable", async () => {
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "resolve-throws" }), "udid")).toBeNull();
  });

  it("returns null on a script error result or non-string result", async () => {
    const errRaw = { ...SCREEN, components: [], error: "No fiber roots" } as RawResult;
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "raw", raw: errRaw }), "udid")).toBeNull();
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "non-string" }), "udid")).toBeNull();
  });

  it("returns null when no fiber yields a usable rect (no regression vs ax fallback)", async () => {
    const raw: RawResult = {
      ...SCREEN,
      components: [
        { id: 0, name: "View", parentIdx: -1, rect: null },
        { id: 1, name: "Text", parentIdx: 0, rect: null, text: "x" },
      ],
    };
    expect(await buildRnPreviewTree(fakeRegistry({ kind: "raw", raw }), "udid")).toBeNull();
  });
});
