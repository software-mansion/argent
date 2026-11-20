import { describe, it, expect } from "vitest";
import {
  MAX_UNCHANGED_IN_A_ROW,
  UNCHANGED_MAX_AGE_MS,
  createTreeMemory,
  describedTree,
  treeIdLine,
  unchangedTreeNote,
} from "../src/unchanged-tree.js";

const TREE_A = "button Done (0.1,0.2,0.3,0.1)";
const TREE_B = "button Save (0.1,0.2,0.3,0.1)";
const MINUTE = 60_000;

function memoryWithClock() {
  const clock = { now: 1_000 };
  return { clock, trees: createTreeMemory(() => clock.now, "t") };
}

const full = (id: string, tree: string) => `${treeIdLine(id)}\n${tree}`;

describe("createTreeMemory", () => {
  it("sends the first tree of a device in full, under its id", () => {
    const { trees } = memoryWithClock();

    expect(trees.afterAction("u", TREE_A, "gesture-tap")).toEqual({
      text: "Tree id: t-1\nbutton Done (0.1,0.2,0.3,0.1)",
      identical: false,
      note: false,
    });
  });

  it("sends a note for an identical tree, naming the full one by id and by tool", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    const second = trees.afterAction("u", TREE_A, "await-ui-element");

    expect(second).toEqual({
      text: unchangedTreeNote("t-1", "gesture-tap"),
      identical: true,
      note: true,
    });
    expect(second.text).not.toContain(TREE_A);
  });

  it("sends a changed tree in full under a new id, and compares the next one with it", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    expect(trees.afterAction("u", TREE_B, "keyboard").text).toBe(full("t-2", TREE_B));
    expect(trees.afterAction("u", TREE_B, "gesture-tap").text).toBe(
      unchangedTreeNote("t-2", "keyboard")
    );
    // The tree before the change is no longer the one the agent reads frames from.
    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(full("t-3", TREE_A));
  });

  it("keeps the trees of two devices apart, and never gives two trees one id", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("ios", TREE_A, "gesture-tap");

    expect(trees.afterAction("android", TREE_A, "gesture-tap").text).toBe(full("t-2", TREE_A));
    expect(trees.afterAction("ios", TREE_A, "gesture-tap").text).toBe(
      unchangedTreeNote("t-1", "gesture-tap")
    );
    expect(trees.afterAction("android", TREE_A, "gesture-tap").text).toBe(
      unchangedTreeNote("t-2", "gesture-tap")
    );
  });

  it("gives the ids of two processes different tags", () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => createTreeMemory().sent("u", TREE_A, "describe"))
    );

    expect(ids.size).toBeGreaterThan(1);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{3}-1$/);
  });

  it("compares with the tree of the agent's own describe call", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    expect(trees.sent("u", TREE_B, "mcp__argent__describe")).toBe("t-2");

    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(full("t-3", TREE_A));
    expect(trees.sent("u", TREE_B, "mcp__argent__describe")).toBe("t-4");
    expect(trees.afterAction("u", TREE_B, "gesture-tap").text).toBe(
      unchangedTreeNote("t-4", "describe")
    );
  });

  it("starts the count and the age again from a describe call that returns the same tree", () => {
    const { clock, trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    for (let i = 0; i < 3; i++) trees.afterAction("u", TREE_A, "await-ui-element");
    clock.now += 4 * MINUTE;

    trees.sent("u", TREE_A, "describe");
    clock.now += 4 * MINUTE;

    for (let i = 0; i < 3; i++) {
      expect(trees.afterAction("u", TREE_A, "await-ui-element").text).toBe(
        unchangedTreeNote("t-2", "describe")
      );
    }
  });

  it("sends the tree again after three notes in a row", () => {
    expect(MAX_UNCHANGED_IN_A_ROW).toBe(3);
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    const notes = [1, 2, 3, 4, 5, 6, 7, 8].map(
      () => trees.afterAction("u", TREE_A, "await-ui-element").note
    );

    // The fourth and the eighth are full trees: the count starts again from each.
    expect(notes).toEqual([true, true, true, false, true, true, true, false]);
  });

  it("reports a tree sent again in full as identical", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    for (let i = 0; i < 3; i++) trees.afterAction("u", TREE_A, "await-ui-element");

    expect(trees.afterAction("u", TREE_A, "gesture-swipe")).toEqual({
      text: full("t-2", TREE_A),
      identical: true,
      note: false,
    });
    expect(trees.afterAction("u", TREE_B, "gesture-swipe")).toEqual({
      text: full("t-3", TREE_B),
      identical: false,
      note: false,
    });
  });

  it("sends the tree again once the last full one is more than five minutes old", () => {
    expect(UNCHANGED_MAX_AGE_MS).toBe(5 * MINUTE);
    const { clock, trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");

    clock.now += 5 * MINUTE;
    expect(trees.afterAction("u", TREE_A, "gesture-tap").note).toBe(true);
    clock.now += 1;
    expect(trees.afterAction("u", TREE_A, "gesture-tap")).toEqual({
      text: full("t-2", TREE_A),
      identical: true,
      note: false,
    });
  });

  it("measures the age from the tree sent again, not from the first one", () => {
    const { clock, trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    clock.now += 5 * MINUTE + 1;
    trees.afterAction("u", TREE_A, "gesture-tap");

    clock.now += 5 * MINUTE;
    expect(trees.afterAction("u", TREE_A, "gesture-tap").text).toBe(
      unchangedTreeNote("t-2", "gesture-tap")
    );
  });

  it("sends the tree in full after the device is forgotten", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", TREE_A, "gesture-tap");
    trees.afterAction("other", TREE_A, "gesture-tap");

    trees.forget("u");

    expect(trees.afterAction("u", TREE_A, "gesture-tap")).toEqual({
      text: full("t-3", TREE_A),
      identical: false,
      note: false,
    });
    expect(trees.afterAction("other", TREE_A, "gesture-tap").note).toBe(true);
  });

  it("sends a tree in full when only describe's hint differs", () => {
    const { trees } = memoryWithClock();
    const plain = describedTree({ description: TREE_A })!;
    const hinted = describedTree({ description: TREE_A, hint: "The display is suspended." })!;
    trees.afterAction("u", plain, "gesture-tap");

    expect(trees.afterAction("u", hinted, "gesture-tap").text).toBe(
      `Tree id: t-2\nHint: The display is suspended.\n${TREE_A}`
    );
    expect(trees.afterAction("u", plain, "gesture-tap").note).toBe(false);
  });
});

describe("unchangedTreeNote", () => {
  it("identifies the earlier tree, notes that action effects may be hidden, and gives the fallback", () => {
    const note = unchangedTreeNote("k3x-7", "gesture-tap");
    expect(note).toContain("k3x-7");
    expect(note).toContain("gesture-tap");
    expect(note).toMatch(/effects.*tree/i);
    expect(note).toContain("describe");
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
