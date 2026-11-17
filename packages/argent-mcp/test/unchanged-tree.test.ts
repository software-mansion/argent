import { describe, it, expect } from "vitest";
import {
  MAX_UNCHANGED_IN_A_ROW,
  UNCHANGED_MAX_AGE_MS,
  createTreeMemory,
  describedTree,
  unchangedTreeNote,
} from "../src/unchanged-tree.js";

const TREE_A = "button Done (0.1,0.2,0.3,0.1)";
const TREE_B = "button Save (0.1,0.2,0.3,0.1)";

function memoryWithClock() {
  const clock = { now: 1_000 };
  return { clock, trees: createTreeMemory(() => clock.now) };
}

describe("createTreeMemory", () => {
  it("sends the first tree of a device in full", () => {
    const { trees } = memoryWithClock();

    expect(trees.afterAction("u", TREE_A, "gesture-tap")).toEqual({
      text: TREE_A,
      unchanged: false,
    });
  });

  it("sends a note for an identical tree, naming the tool that returned the full one", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    const second = trees.afterAction("u", TREE_A, "await-ui-element");

    expect(second).toEqual({ text: unchangedTreeNote("gesture-tap"), unchanged: true });
    expect(second.text).not.toContain(TREE_A);
  });

  it("sends a changed tree in full, and compares the next one with it", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    expect(trees.afterAction("u", TREE_B, "keyboard").text).toBe(TREE_B);
    expect(trees.afterAction("u", TREE_B, "gesture-tap").text).toBe(unchangedTreeNote("keyboard"));
    // The tree before the change is no longer the one the agent reads frames from.
    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(TREE_A);
  });

  it("keeps the trees of two devices apart", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("ios", TREE_A, "gesture-tap");

    expect(trees.afterAction("android", TREE_A, "gesture-tap").unchanged).toBe(false);
    expect(trees.afterAction("ios", TREE_A, "gesture-tap").unchanged).toBe(true);
  });

  it("compares with the tree of the agent's own describe call", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    trees.sent("u", TREE_B, "mcp__argent__describe");

    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(TREE_A);
    trees.sent("u", TREE_B, "mcp__argent__describe");
    expect(trees.afterAction("u", TREE_B, "gesture-tap").text).toBe(unchangedTreeNote("describe"));
  });

  it("sends the tree again after the notes in a row reach the limit", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    for (let i = 0; i < MAX_UNCHANGED_IN_A_ROW; i++) {
      expect(trees.afterAction("u", TREE_A, "await-ui-element").unchanged).toBe(true);
    }
    expect(trees.afterAction("u", TREE_A, "gesture-swipe")).toEqual({
      text: TREE_A,
      unchanged: false,
    });
    // The count starts again from the tree just sent.
    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(
      unchangedTreeNote("gesture-swipe")
    );
  });

  it("sends the tree again once the last full one is too old", () => {
    const { clock, trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    clock.now += UNCHANGED_MAX_AGE_MS;
    expect(trees.afterAction("u", TREE_A, "gesture-tap").unchanged).toBe(true);
    clock.now += 1;
    expect(trees.afterAction("u", TREE_A, "gesture-tap").unchanged).toBe(false);
  });
});

describe("unchangedTreeNote", () => {
  it("says which tree it stands for and how to get it again", () => {
    expect(unchangedTreeNote("gesture-tap")).toBe(
      "Same as the last full element tree returned for this device (in a `gesture-tap` result): no element or frame changed, so it is not repeated here. Call describe if you no longer have that tree."
    );
  });
});

describe("describedTree", () => {
  it("puts describe's hint before the tree", () => {
    expect(describedTree({ description: TREE_A, hint: "2 elements omitted." })).toBe(
      `Hint: 2 elements omitted.\n${TREE_A}`
    );
  });

  it("leaves out a hint the tree already contains", () => {
    const description = `Focusable: (none reported)\n\nNote: Wait and call describe again.`;

    expect(describedTree({ description, hint: "Wait and call describe again." })).toBe(description);
  });

  it.each([null, undefined, {}, { description: "" }, { description: 3 }])(
    "has no tree for %j",
    (result) => {
      expect(describedTree(result)).toBeUndefined();
    }
  );
});
