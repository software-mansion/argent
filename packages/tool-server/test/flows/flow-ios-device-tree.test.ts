import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { IosDeviceRunnerApi } from "../../src/blueprints/ios-device-runner";
import type { DescribeNode } from "../../src/tools/describe/contract";
import type { RunnerSnapshotNode } from "../../src/utils/ios-device/runner-commands";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";
import { queryIosDeviceFlowTree } from "../../src/tools/flows/flow-ios-tree";
import {
  assertText,
  evaluateCondition,
  findAll,
  nodeText,
  selectorToFrame,
} from "../../src/utils/ui-tree-match";

// The flow contract on hardware (the Vega/Chromium tests pin the same contract
// for their adapters): the runner's accessibility snapshot must reach flows as
// flat leaves under one root with descendant text hoisted onto container
// leaves. Without the hoist a `text` assert scoped to a testID container reads
// the container's own empty label instead of the text it visibly wraps, which
// fails the canonical docs example
// (`assert: { text: { in: { id: preference-status }, equals: Enabled } }`)
// on every physical device while passing on a simulator.

const DEVICE_UDID = "00008110-000978540290401E";
const APP = "com.example.app";

const IOS_DEVICE = {
  id: DEVICE_UDID,
  platform: "ios",
  kind: "device",
} as unknown as DeviceInfo;

function node(
  partial: Partial<RunnerSnapshotNode> & { index: number; depth: number }
): RunnerSnapshotNode {
  return {
    type: "Other",
    label: null,
    identifier: null,
    value: null,
    rect: { x: 0, y: 0, width: 390, height: 844 },
    enabled: true,
    focused: null,
    selected: null,
    parentIndex: null,
    ...partial,
  };
}

/**
 * A screen shaped the way hardware reports a React Native testID `View`
 * wrapping a `Text`: the container carries the `accessibilityIdentifier` and no
 * label of its own, the text lives on a StaticText child, and one row sits
 * below the app frame (the describe adapter clamps it to zero area).
 */
function snapshot(): RunnerSnapshotNode[] {
  return [
    node({ index: 0, depth: 0, type: "Application" }),
    node({
      index: 1,
      depth: 1,
      parentIndex: 0,
      identifier: "summary-card",
      rect: { x: 16, y: 120, width: 358, height: 160 },
    }),
    node({
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: "StaticText",
      label: "Total",
      rect: { x: 24, y: 130, width: 120, height: 24 },
    }),
    node({
      index: 3,
      depth: 2,
      parentIndex: 1,
      identifier: "preference-status",
      rect: { x: 24, y: 200, width: 340, height: 44 },
    }),
    node({
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: "StaticText",
      label: "Enabled",
      rect: { x: 32, y: 210, width: 120, height: 24 },
    }),
    node({
      index: 5,
      depth: 2,
      parentIndex: 1,
      type: "StaticText",
      label: "Below the fold",
      rect: { x: 24, y: 900, width: 200, height: 24 },
    }),
    node({
      index: 6,
      depth: 1,
      parentIndex: 0,
      type: "Button",
      label: "Continue",
      rect: { x: 16, y: 760, width: 358, height: 52 },
    }),
  ];
}

function registryFor(api: IosDeviceRunnerApi): Registry {
  return { resolveService: async () => api } as unknown as Registry;
}

/**
 * A mid-screen ScrollView the way the runner reports it: the scroller's own
 * frame is on screen, one row sits inside its viewport and one has been
 * scrolled out of it while still inside the Application frame, so the runner
 * emits the scrolled-out row with its raw, on-screen frame.
 */
function scrolledSnapshot(): RunnerSnapshotNode[] {
  return [
    node({ index: 0, depth: 0, type: "Application" }),
    node({
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: "ScrollView",
      identifier: "feed",
      rect: { x: 0, y: 100, width: 390, height: 400 },
    }),
    node({
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: "StaticText",
      label: "Feed header",
      rect: { x: 16, y: 110, width: 200, height: 24 },
    }),
    node({
      index: 3,
      depth: 2,
      parentIndex: 1,
      identifier: "row-2",
      rect: { x: 0, y: 150, width: 390, height: 100 },
    }),
    node({
      index: 4,
      depth: 3,
      parentIndex: 3,
      type: "StaticText",
      label: "Row 2",
      rect: { x: 16, y: 170, width: 120, height: 24 },
    }),
    node({
      index: 5,
      depth: 2,
      parentIndex: 1,
      identifier: "row-7",
      rect: { x: 0, y: 600, width: 390, height: 100 },
    }),
    node({
      index: 6,
      depth: 3,
      parentIndex: 5,
      type: "StaticText",
      label: "Row 7",
      rect: { x: 16, y: 620, width: 120, height: 24 },
    }),
    node({
      index: 7,
      depth: 2,
      parentIndex: 1,
      type: "StaticText",
      label: "Load more",
      rect: { x: 16, y: 720, width: 200, height: 24 },
    }),
    node({
      index: 8,
      depth: 1,
      parentIndex: 0,
      type: "Button",
      label: "Continue",
      rect: { x: 16, y: 760, width: 358, height: 52 },
    }),
  ];
}

async function flowTree(nodes: RunnerSnapshotNode[] = snapshot()): Promise<DescribeNode> {
  const run = vi.fn(async () => ({ nodes, quality: null }));
  const { tree } = await queryIosDeviceFlowTree(
    registryFor({ udid: DEVICE_UDID, run }),
    IOS_DEVICE
  );
  return tree;
}

describe("queryIosDeviceFlowTree: flow-contract adaptation", () => {
  setCurrentIosDeviceApp(DEVICE_UDID, APP);

  it("hoists a child's text onto a testID container so the docs `equals` assert passes", async () => {
    const tree = await flowTree();
    const matches = findAll(tree, { identifier: "preference-status" });

    expect(matches).toHaveLength(1);
    // The container's own text is empty: the hoist is the whole reason the
    // assert can read what the container wraps.
    expect(nodeText(matches[0]!)).toBe("");
    expect(assertText(matches[0]!)).toBe("Enabled");
    expect(evaluateCondition("text", "Enabled", matches, "equals")).toBe(true);
  });

  it("scopes hoisted text to the nearest testID ancestor", async () => {
    const tree = await flowTree();
    const card = findAll(tree, { identifier: "summary-card" });

    expect(card).toHaveLength(1);
    // preference-status shields its own subtree, so the outer card reads only
    // the text it renders directly.
    expect(assertText(card[0]!)).toBe("Total");
  });

  it("keeps a zero-area (below the fold) node matchable but never hoists its text", async () => {
    const tree = await flowTree();
    const below = findAll(tree, { text: "Below the fold" });

    expect(evaluateCondition("exists", undefined, below)).toBe(true);
    expect(evaluateCondition("visible", undefined, below)).toBe(false);
    const walk = (n: DescribeNode): string[] => [n.subtreeText ?? "", ...n.children.flatMap(walk)];
    expect(walk(tree).join(" ")).not.toContain("Below the fold");
  });

  it("emits flat leaves under the Application root, keeping selector targeting on the text node", async () => {
    const tree = await flowTree();

    expect(tree.role).toBe("Application");
    expect(tree.children.length).toBeGreaterThan(0);
    for (const child of tree.children) expect(child.children).toHaveLength(0);
    // Selector matching still reads a node's OWN text, so a tap/await by text
    // resolves the StaticText leaf rather than its container.
    const text = findAll(tree, { text: "Enabled" });
    expect(text).toHaveLength(1);
    expect(text[0]!.role).toBe("AXStaticText");
  });

  // Scroll-clip prune, the same contract the simulator and Android projections
  // honor: the runner only drops what lies outside the Application frame, so a
  // row scrolled out of a mid-screen ScrollView still arrives with an on-screen
  // frame. Keeping it would falsely fail `assert { hidden }`, falsely pass
  // `visible`, hoist its text onto the scroller and resolve a tap below the
  // scroller's fold.
  it("drops a row scrolled out of a mid-screen ScrollView viewport", async () => {
    const tree = await flowTree(scrolledSnapshot());

    // The in-viewport row resolves; the scrolled-out one is gone entirely,
    // node, testID and text.
    expect(findAll(tree, { identifier: "row-2" })).toHaveLength(1);
    expect(findAll(tree, { text: "Row 2" })).toHaveLength(1);
    const clipped = findAll(tree, { identifier: "row-7" });
    expect(clipped).toHaveLength(0);
    expect(JSON.stringify(tree)).not.toContain("Row 7");
    expect(evaluateCondition("hidden", undefined, clipped)).toBe(true);
    expect(evaluateCondition("visible", undefined, clipped)).toBe(false);
    // No tap point resolves below the scroller's fold, by id or by text.
    expect(selectorToFrame(tree, { identifier: "row-7" })).toBeUndefined();
    expect(selectorToFrame(tree, { text: "Row 7" })).toBeUndefined();
    // The scroller hoists only the text its viewport shows: the in-view header
    // and not the scrolled-out, unshielded "Load more".
    const feed = findAll(tree, { identifier: "feed" });
    expect(feed).toHaveLength(1);
    expect(assertText(feed[0]!)).toBe("Feed header");
    expect(JSON.stringify(tree)).not.toContain("Load more");
    // Siblings outside the scroller are never clipped by it.
    expect(findAll(tree, { text: "Continue" })).toHaveLength(1);
  });
});
