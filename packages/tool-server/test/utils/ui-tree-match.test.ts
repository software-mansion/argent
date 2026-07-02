import { describe, it, expect } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import {
  nodeAtPoint,
  selectorToFrame,
  deriveSelector,
  evaluateCondition,
  findAll,
  treeFingerprint,
} from "../../src/utils/ui-tree-match";

function node(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

const root = node({
  role: "AXGroup",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    node({
      role: "AXButton",
      label: "Login",
      identifier: "login-btn",
      frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    }),
    node({
      role: "AXStaticText",
      label: "Welcome back",
      frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
    }),
    node({
      // overlapping container around the button — larger area
      role: "AXGroup",
      frame: { x: 0, y: 0.05, width: 0.5, height: 0.2 },
      children: [],
    }),
  ],
});

describe("ui-tree-match", () => {
  it("nodeAtPoint returns the smallest element under a point", () => {
    // (0.2, 0.15) sits inside both the button and the surrounding group; the
    // button has the smaller area and wins.
    const hit = nodeAtPoint(root, { x: 0.2, y: 0.15 });
    expect(hit?.label).toBe("Login");
  });

  it("nodeAtPoint returns undefined when nothing is under the point", () => {
    expect(nodeAtPoint(root, { x: 0.95, y: 0.95 })).toBeUndefined();
  });

  it("selectorToFrame resolves the first visible match", () => {
    const frame = selectorToFrame(root, { text: "Welcome" });
    expect(frame).toMatchObject({ x: 0.1, y: 0.3 });
  });

  // iOS flattens an accessible container's descendants into its own label
  // (e.g. an RNGH Touchable wrapping nested layers), so a text selector
  // substring-matches the container as well as the leaf that carries the text.
  // Modeled on the nested-touchables example screen.
  const aggregated = node({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      node({
        role: "AXGroup",
        label: "Outer Touchable Inner tap gesture Inner Touchable",
        identifier: "outer-touchable",
        frame: { x: 0.18, y: 0.45, width: 0.64, height: 0.19 },
      }),
      node({
        role: "AXStaticText",
        label: "Outer Touchable",
        frame: { x: 0.37, y: 0.47, width: 0.26, height: 0.02 },
      }),
      node({
        role: "AXStaticText",
        label: "Inner tap gesture",
        frame: { x: 0.36, y: 0.52, width: 0.27, height: 0.02 },
      }),
      node({
        role: "AXGroup",
        label: "Inner Touchable",
        identifier: "inner-touchable",
        frame: { x: 0.28, y: 0.56, width: 0.45, height: 0.05 },
      }),
      node({
        role: "AXStaticText",
        label: "Inner Touchable",
        frame: { x: 0.37, y: 0.57, width: 0.25, height: 0.02 },
      }),
    ],
  });

  it("selectorToFrame prefers an exact label over a container whose aggregated label contains it", () => {
    // The outer AXGroup is topmost and substring-matches, but its centre sits
    // over a nested child; the exact-label leaf must win.
    const frame = selectorToFrame(aggregated, { text: "Outer Touchable" });
    expect(frame).toMatchObject({ x: 0.37, y: 0.47 });
  });

  it("selectorToFrame prefers the smallest of several exact matches", () => {
    // Both the inner AXGroup and its leaf text are exactly "Inner Touchable";
    // the leaf (smaller, more specific) wins — same philosophy as nodeAtPoint.
    const frame = selectorToFrame(aggregated, { text: "Inner Touchable" });
    expect(frame).toMatchObject({ x: 0.37, y: 0.57 });
  });

  it("selectorToFrame keeps reading order as the tiebreak for equally ranked matches", () => {
    const rows = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Row item", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
        node({ label: "Row item", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } }),
      ],
    });
    expect(selectorToFrame(rows, { text: "Row item" })).toMatchObject({ y: 0.2 });
  });

  it("deriveSelector prefers identifier, then text, then specific role", () => {
    expect(
      deriveSelector(
        node({ identifier: "id1", label: "x", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } })
      )
    ).toEqual({ identifier: "id1" });
    expect(
      deriveSelector(node({ label: "Hi", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toEqual({ text: "Hi" });
    // generic role → no stable selector
    expect(
      deriveSelector(node({ role: "AXGroup", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toBeNull();
    // specific role → role selector
    expect(
      deriveSelector(node({ role: "AXButton", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toEqual({ role: "AXButton" });
  });

  it("evaluateCondition handles exists/visible/hidden/text", () => {
    const matches = findAll(root, { text: "Login" });
    expect(evaluateCondition("exists", undefined, matches)).toBe(true);
    expect(evaluateCondition("visible", undefined, matches)).toBe(true);
    expect(evaluateCondition("hidden", undefined, matches)).toBe(false);
    expect(evaluateCondition("text", "Login", matches)).toBe(true);
    expect(evaluateCondition("text", "Logout", matches)).toBe(false);
    expect(evaluateCondition("exists", undefined, findAll(root, { text: "Nope" }))).toBe(false);
  });

  it("treeFingerprint is stable for an unchanged tree and changes when a frame moves", () => {
    const a = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } })],
    });
    const same = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } })],
    });
    const moved = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      // same row scrolled up — a fling still in flight
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.05, width: 0.8, height: 0.1 } })],
    });
    expect(treeFingerprint(a)).toBe(treeFingerprint(same));
    expect(treeFingerprint(a)).not.toBe(treeFingerprint(moved));
  });

  it("treeFingerprint ignores sub-1e-3 jitter", () => {
    const a = node({ frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    const jittered = node({ frame: { x: 0.10001, y: 0.2, width: 0.3, height: 0.4 } });
    expect(treeFingerprint(a)).toBe(treeFingerprint(jittered));
  });
});
