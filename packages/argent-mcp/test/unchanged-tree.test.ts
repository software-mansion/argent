import { describe, it, expect } from "vitest";
import {
  MAX_UNCHANGED_IN_A_ROW,
  UNCHANGED_MAX_AGE_MS,
  createTreeMemory,
  formatTreeDiff,
  treeDiffHeader,
  treeIdLine,
  unchangedTreeNote,
} from "../src/unchanged-tree.js";
import { describedTree } from "@argent/tools-client";

const TREE_A = "button Done (0.1,0.2,0.3,0.1)";
const TREE_B = "button Save (0.1,0.2,0.3,0.1)";
const LONG_TREE = [
  "Source: ax-service",
  "Mode: flat",
  "",
  "ROOT  AXApplication (0.000,0.000,1.000,1.000)",
  ...Array.from(
    { length: 20 },
    (_, i) => `  AXButton "Row ${i}" (0.000,${(i * 0.04).toFixed(3)},1.000,0.040)`
  ),
].join("\n");
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
      mode: "full",
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
      mode: "unchanged",
      identical: true,
      note: true,
    });
    expect(second.text).not.toContain(TREE_A);
  });

  it("sends a cumulative diff against the last full tree when only a few lines change", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "gesture-tap");

    const afterOne = LONG_TREE.replace('"Row 2"', '"Row 2" value="on"');
    const first = trees.afterAction("u", afterOne, "gesture-tap");
    expect(first).toEqual({
      mode: "diff",
      identical: false,
      note: false,
      text: [
        treeDiffHeader("t-1", "gesture-tap"),
        '    AXButton "Row 1" (0.000,0.040,1.000,0.040)',
        '-   AXButton "Row 2" (0.000,0.080,1.000,0.040)',
        '+   AXButton "Row 2" value="on" (0.000,0.080,1.000,0.040)',
        '    AXButton "Row 3" (0.000,0.120,1.000,0.040)',
      ].join("\n"),
    });

    // A second monotonic edit diffs against the same full tree `t-1`, never chaining diffs.
    const afterTwo = afterOne + '\n  AXStaticText "Saved" (0.100,0.900,0.200,0.050)';
    const second = trees.afterAction("u", afterTwo, "keyboard");
    expect(second).toEqual({
      mode: "diff",
      identical: false,
      note: false,
      text: [
        treeDiffHeader("t-1", "gesture-tap"),
        '    AXButton "Row 1" (0.000,0.040,1.000,0.040)',
        '-   AXButton "Row 2" (0.000,0.080,1.000,0.040)',
        '+   AXButton "Row 2" value="on" (0.000,0.080,1.000,0.040)',
        '    AXButton "Row 3" (0.000,0.120,1.000,0.040)',
        "...",
        '    AXButton "Row 19" (0.000,0.760,1.000,0.040)',
        '+   AXStaticText "Saved" (0.100,0.900,0.200,0.050)',
      ].join("\n"),
    });
  });

  it("falls back to a full tree when a prior diff reverts back to the base tree", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "describe");

    // Step 1: Row 2 changes from base -> diff.
    const step1 = LONG_TREE.replace('"Row 2"', '"Row 2" value="on"');
    expect(trees.afterAction("u", step1, "gesture-tap").mode).toBe("diff");

    // Step 2: Row 2 reverts back to base while Row 5 changes -> fresh full tree (no chaining).
    const step2 = LONG_TREE.replace('"Row 5"', '"Row 5" value="on"');
    const second = trees.afterAction("u", step2, "gesture-tap");
    expect(second).toEqual({
      mode: "full",
      identical: false,
      note: false,
      text: full("t-2", step2),
    });
  });

  it("sends a full tree when the screen returns to the base tree after a diff", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "describe");

    const toggledOn = LONG_TREE.replace('"Row 2"', '"Row 2" value="on"');
    expect(trees.afterAction("u", toggledOn, "gesture-tap").mode).toBe("diff");

    // Toggling back off returns to LONG_TREE; sending a plain unchanged note
    // would not tell the agent that the previous diff no longer applies.
    const toggledOff = trees.afterAction("u", LONG_TREE, "gesture-tap");
    expect(toggledOff).toEqual({
      mode: "full",
      identical: true,
      note: false,
      text: full("t-2", LONG_TREE),
    });
  });

  it("counts diffs and unchanged notes together toward the consecutive cap", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "gesture-tap");
    const edited1 = LONG_TREE.replace('"Row 2"', '"Row 2" value="on"');
    const edited2 = edited1.replace('"Row 5"', '"Row 5" value="on"');

    expect(trees.afterAction("u", LONG_TREE, "await-ui-element").mode).toBe("unchanged");
    expect(trees.afterAction("u", edited1, "gesture-tap").mode).toBe("diff");
    expect(trees.afterAction("u", edited2, "gesture-tap").mode).toBe("diff");
    // Fourth non-full result in a row refreshes the full tree under a new id.
    const refreshed = trees.afterAction("u", edited2, "gesture-tap");
    expect(refreshed.mode).toBe("full");
    expect(refreshed.text).toBe(full("t-2", edited2));
  });

  it("falls back to the full tree when most of the tree changed", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "gesture-tap");

    const navigated = LONG_TREE.replaceAll("Row ", "Setting ");
    const result = trees.afterAction("u", navigated, "gesture-tap");
    expect(result).toEqual({
      mode: "full",
      identical: false,
      note: false,
      text: full("t-2", navigated),
    });
  });

  it("falls back to the full tree when Source or Mode header changes", () => {
    const { trees } = memoryWithClock();
    trees.afterAction("u", LONG_TREE, "gesture-tap");

    const otherSource = LONG_TREE.replace("Source: ax-service", "Source: native-devtools");
    expect(trees.afterAction("u", otherSource, "gesture-tap").mode).toBe("full");
  });

  it("sends a changed tree in full under a new id when the diff is not short enough", () => {
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
      mode: "full",
      identical: true,
      note: false,
    });
    expect(trees.afterAction("u", TREE_B, "gesture-swipe")).toEqual({
      text: full("t-3", TREE_B),
      mode: "full",
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
      mode: "full",
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
      mode: "full",
      identical: false,
      note: false,
    });
    expect(trees.afterAction("other", TREE_A, "gesture-tap").note).toBe(true);
  });

  it("sends a tree in full when only describe's hint differs", () => {
    const { trees } = memoryWithClock();
    const plain = describedTree({ description: LONG_TREE })!;
    const hinted = describedTree({ description: LONG_TREE, hint: "The display is suspended." })!;
    trees.afterAction("u", plain, "gesture-tap");

    expect(trees.afterAction("u", hinted, "gesture-tap")).toEqual({
      mode: "full",
      identical: false,
      note: false,
      text: `Tree id: t-2\nHint: The display is suspended.\n${LONG_TREE}`,
    });
    expect(trees.afterAction("u", plain, "gesture-tap").mode).toBe("full");
  });
});

describe("formatTreeDiff", () => {
  it("never reports TV focus moves between identically named tiles as unchanged, and shows context", () => {
    const shortBefore = [
      "Row 1:",
      "  Alpha",
      "  Bravo",
      "→ See all",
      "Row 2:",
      "  Charlie",
      "  Delta",
      "  See all",
    ].join("\n");
    const shortAfter = shortBefore
      .replace("→ See all", "  See all")
      .replace("  Delta\n  See all", "  Delta\n→ See all");
    const { trees } = memoryWithClock();
    trees.sent("tv", shortBefore, "describe");
    // Even on a tiny 2-row TV tree, focus moving between two "See all" items must never collapse to unchanged.
    expect(trees.afterAction("tv", shortAfter, "tv-remote")).toEqual({
      mode: "full",
      identical: false,
      note: false,
      text: full("t-2", shortAfter),
    });

    const longBefore = [
      shortBefore,
      ...Array.from(
        { length: 12 },
        (_, i) => `Row ${i + 3}:\n  Featured Episode ${i + 3} — Season 1\n  Trending Now ${i + 3}`
      ),
    ].join("\n");
    const longAfter = longBefore
      .replace("→ See all", "  See all")
      .replace("  Delta\n  See all", "  Delta\n→ See all");

    const diff = formatTreeDiff(longBefore, longAfter, "yf1-1", "describe");
    expect(diff).toEqual({
      mode: "diff",
      text: [
        treeDiffHeader("yf1-1", "describe"),
        "    Bravo",
        "- → See all",
        "+   See all",
        "  Row 2:",
        "...",
        "    Delta",
        "-   See all",
        "+ → See all",
        "  Row 3:",
      ].join("\n"),
    });
  });

  it("detects pure line reordering such as swapped DOM siblings", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `  button "Item ${i}" (0.000,${(i * 0.04).toFixed(3)},1.000,0.040)`
    );
    const before = lines.join("\n");
    const swapped = [...lines];
    [swapped[5], swapped[6]] = [swapped[6]!, swapped[5]!];
    const after = swapped.join("\n");

    const diff = formatTreeDiff(before, after, "c1-1", "describe");
    expect(diff?.mode).toBe("diff");
    expect(diff?.text).toContain('-   button "Item 5"');
    expect(diff?.text).toContain('+   button "Item 5"');
  });

  it("counts repeated lines by multiset multiplicity with surrounding context", () => {
    const dup = "  AXImage (0.000,0.000,0.100,0.100)";
    const before = `${LONG_TREE}\n${dup}\n${dup}`;
    const after = `${LONG_TREE}\n${dup}`;

    expect(formatTreeDiff(before, after, "t-1", "gesture-tap")).toEqual({
      mode: "diff",
      text: `${treeDiffHeader("t-1", "gesture-tap")}\n  ${dup}\n- ${dup}`,
    });
    expect(formatTreeDiff(after, before, "t-1", "gesture-tap")).toEqual({
      mode: "diff",
      text: `${treeDiffHeader("t-1", "gesture-tap")}\n  ${dup}\n+ ${dup}`,
    });
  });

  it("treats a single trailing newline difference as unchanged", () => {
    expect(formatTreeDiff(LONG_TREE, `${LONG_TREE}\n`, "t-1", "gesture-tap")).toEqual({
      mode: "unchanged",
      text: unchangedTreeNote("t-1", "gesture-tap"),
    });
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
