import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Spy on the shared Vega describe so the routing tests below can feed
// fetchFlowTree a page-source-shaped tree without an adb round-trip.
const describeVega = vi.fn(async (): Promise<DescribeTreeData> => {
  throw new Error("describeVega result not stubbed for this test");
});
vi.mock("../../src/tools/describe/platforms/vega", () => ({
  vegaRequires: ["adb"],
  describeVega: (...args: unknown[]) => describeVega(...(args as [])),
}));

import { adaptVegaTreeForFlows } from "../../src/tools/flows/flow-vega-tree";
import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { assertText, evaluateCondition, findAll } from "../../src/utils/ui-tree-match";

const FULL = { x: 0, y: 0, width: 1, height: 1 };

function el(partial: Partial<DescribeNode>): DescribeNode {
  return { role: "view", frame: FULL, children: [], ...partial } as DescribeNode;
}

// A screen shaped like the parsed Vega page source (see `parseVegaPageSource`):
// the toolkit stamps every node with an auto-generated numeric `test_id`
// (surfaced as its `identifier`) and puts text on child `text` nodes, so a
// container's own label is empty even when it visibly wraps text — an authored
// `testID` container, a nav button whose "Home" lives on a text child, and a
// row scrolled off-screen (frame clamped to zero area by the parser).
function screen(): DescribeNode {
  return el({
    role: "Screen",
    children: [
      el({
        identifier: "score-box",
        frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
        children: [
          el({
            role: "text",
            identifier: "118",
            label: "Score",
            frame: { x: 0.12, y: 0.12, width: 0.2, height: 0.05 },
          }),
          el({
            role: "text",
            identifier: "124",
            label: "42",
            frame: { x: 0.12, y: 0.2, width: 0.1, height: 0.05 },
          }),
          el({
            role: "text",
            identifier: "130",
            label: "Below the fold",
            frame: { x: 0.12, y: 1, width: 0.2, height: 0 },
          }),
        ],
      }),
      el({
        role: "button",
        clickable: true,
        identifier: "14",
        frame: { x: 0.02, y: 0.02, width: 0.09, height: 0.06 },
        children: [
          el({
            role: "text",
            identifier: "10",
            label: "Home",
            frame: { x: 0.03, y: 0.03, width: 0.07, height: 0.04 },
          }),
        ],
      }),
    ],
  });
}

describe("adaptVegaTreeForFlows", () => {
  it("hoists descendant text onto an authored-testID container for text asserts", () => {
    const tree = adaptVegaTreeForFlows(screen());
    const matches = findAll(tree, { identifier: "score-box" });
    expect(matches).toHaveLength(1);
    expect(assertText(matches[0]!)).toContain("42");
    expect(evaluateCondition("text", "42", matches, "contains")).toBe(true);
  });

  it("hoists through auto-generated numeric test_ids (they must not shield)", () => {
    const tree = adaptVegaTreeForFlows(screen());
    // The "Home" text node carries the auto id "10"; if numeric ids shielded,
    // the wrapping button (auto id "14") would read empty text.
    const button = findAll(tree, { role: "button" }).find((n) => n.clickable);
    expect(button).toBeDefined();
    expect(assertText(button!)).toContain("Home");
  });

  it("scopes hoisted text to the nearest authored-testID ancestor", () => {
    const inner = el({
      identifier: "inner-box",
      frame: { x: 0, y: 0, width: 1, height: 0.2 },
      children: [
        el({
          role: "text",
          identifier: "12",
          label: "Inner detail",
          frame: { x: 0, y: 0.05, width: 0.5, height: 0.05 },
        }),
      ],
    });
    const outer = el({
      identifier: "outer-box",
      frame: { x: 0, y: 0, width: 1, height: 0.5 },
      children: [
        inner,
        el({
          role: "text",
          identifier: "16",
          label: "Outer label",
          frame: { x: 0, y: 0.3, width: 0.5, height: 0.05 },
        }),
      ],
    });
    const tree = adaptVegaTreeForFlows(el({ role: "Screen", children: [outer] }));
    // inner-box shields its detail: the outer container must not swallow it.
    const outerMatch = findAll(tree, { identifier: "outer-box" });
    expect(outerMatch).toHaveLength(1);
    expect(assertText(outerMatch[0]!)).toContain("Outer label");
    expect(assertText(outerMatch[0]!)).not.toContain("Inner detail");
    const innerMatch = findAll(tree, { identifier: "inner-box" });
    expect(assertText(innerMatch[0]!)).toContain("Inner detail");
  });

  it("keeps zero-area (scrolled-off) nodes for `exists` but never hoists their text", () => {
    const tree = adaptVegaTreeForFlows(screen());
    // The shared describe tree kept zero-area nodes, and `exists` deliberately
    // accepts them — the adapter must not silently drop what a selector saw.
    const below = findAll(tree, { text: "Below the fold" });
    expect(evaluateCondition("exists", undefined, below)).toBe(true);
    expect(evaluateCondition("visible", undefined, below)).toBe(false);
    const walk = (n: DescribeNode): string[] => [n.subtreeText ?? "", ...n.children.flatMap(walk)];
    expect(walk(tree).join(" ")).not.toContain("Below the fold");
  });

  it("keeps selector targeting on child text (await by text still resolves)", () => {
    const tree = adaptVegaTreeForFlows(screen());
    const matches = findAll(tree, { text: "Home" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.frame.height).toBeGreaterThan(0);
  });

  it("emits flat leaves under one Screen root", () => {
    const tree = adaptVegaTreeForFlows(screen());
    expect(tree.role).toBe("Screen");
    expect(tree.children.length).toBeGreaterThan(0);
    for (const child of tree.children) {
      expect(child.children).toHaveLength(0);
    }
  });
});

describe("fetchFlowTree on Vega", () => {
  const device = { platform: "vega", id: "vega-1" } as unknown as DeviceInfo;

  it("routes through the adapter so a text assert on a testID container reads its text", async () => {
    describeVega.mockResolvedValueOnce({ tree: screen(), source: "vega-automation" });
    const { tree, source } = await fetchFlowTree({} as Registry, device);
    expect(source).toBe("vega-automation");
    const matches = findAll(tree, { identifier: "score-box" });
    expect(evaluateCondition("text", "42", matches, "contains")).toBe(true);
  });

  it("passes the toolkit-outage hint through for the blind-read guard", async () => {
    describeVega.mockResolvedValueOnce({
      tree: { role: "Screen", frame: FULL, children: [] },
      source: "vega-automation",
      hint: "relaunch the foreground app",
    });
    const data = await fetchFlowTree({} as Registry, device);
    expect(data.hint).toBe("relaunch the foreground app");
    expect(data.tree.children).toHaveLength(0);
  });
});
