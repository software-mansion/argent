import { describe, it, expect } from "vitest";
import { adaptFullHierarchyToDescribeResult } from "../src/tools/flows/flow-ios-tree";
import { evaluateCondition, findAll, selectorToFrame } from "../src/utils/ui-tree-match";

// A getFullHierarchy payload shaped like SerializeView output: a window spanning
// the screen, an `accessible` carousel container carrying a testID, and its
// child square views (each with an accessibilityLabel) nested *underneath* it.
// The accessibility tree would collapse the container and hide the squares; the
// full UIView hierarchy keeps both.
const SCREEN = { x: 0, y: 0, width: 400, height: 800 };

function payload() {
  return {
    windows: [
      {
        className: "UIWindow",
        frame: SCREEN,
        windowFrame: SCREEN,
        children: [
          {
            className: "RCTView",
            identifier: "carouselStrip",
            windowFrame: { x: 20, y: 300, width: 360, height: 120 },
            children: [
              {
                className: "RCTView",
                label: "square-#b58df1",
                windowFrame: { x: 24, y: 304, width: 100, height: 100 },
                children: [],
              },
              {
                className: "RCTView",
                label: "square-#001A72",
                windowFrame: { x: 132, y: 304, width: 100, height: 100 },
                children: [],
              },
              // A pure layout view (no id / no label) — should be pruned.
              {
                className: "RCTView",
                windowFrame: { x: 240, y: 304, width: 100, height: 100 },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("describe full-hierarchy adapter", () => {
  it("surfaces an accessible container's testID AND its children un-collapsed", () => {
    const tree = adaptFullHierarchyToDescribeResult(payload());

    // The container resolves by its testID (identifier selector).
    const container = findAll(tree, { identifier: "carouselStrip" });
    expect(container).toHaveLength(1);

    // ...and the child squares are still present as separate nodes.
    expect(findAll(tree, { text: "square-#b58df1" })).toHaveLength(1);
    expect(findAll(tree, { text: "square-#001A72" })).toHaveLength(1);
  });

  it("normalizes window-space frames against the screen size", () => {
    const tree = adaptFullHierarchyToDescribeResult(payload());
    const frame = selectorToFrame(tree, { identifier: "carouselStrip" });
    // 20/400, 300/800, 360/400, 120/800
    expect(frame).toEqual({ x: 0.05, y: 0.375, width: 0.9, height: 0.15 });
  });

  it("prunes layout views with no identifier or label", () => {
    const tree = adaptFullHierarchyToDescribeResult(payload());
    // carouselStrip + two labelled squares = 3 leaves; the bare RCTView is dropped.
    expect(tree.children).toHaveLength(3);
  });

  it("drops hidden / transparent subtrees", () => {
    const raw = payload();
    raw.windows[0]!.children[0]!.children[0] = {
      className: "RCTView",
      label: "square-#b58df1",
      windowFrame: { x: 24, y: 304, width: 100, height: 100 },
      hidden: true,
      children: [],
    } as never;
    const tree = adaptFullHierarchyToDescribeResult(raw);
    expect(findAll(tree, { text: "square-#b58df1" })).toHaveLength(0);
  });

  it("clips a partly off-screen element's frame to the viewport", () => {
    const raw = payload();
    // Push one square half below the fold: 100px tall at y=750 on an 800px
    // screen ⇒ 50px (half) visible.
    raw.windows[0]!.children[0]!.children[1] = {
      className: "RCTView",
      label: "square-#001A72",
      windowFrame: { x: 132, y: 750, width: 100, height: 100 },
      children: [],
    } as never;
    const tree = adaptFullHierarchyToDescribeResult(raw);

    // The emitted frame is clipped to the viewport (100px→50px visible height),
    // so it sits flush at the bottom edge — the signal scroll-to's axis check
    // reads to know the element is only partly on screen.
    const partial = findAll(tree, { text: "square-#001A72" })[0]!;
    expect(partial.frame.y).toBeCloseTo(750 / 800, 5);
    expect(partial.frame.height).toBeCloseTo(50 / 800, 5);
    expect(partial.frame.y + partial.frame.height).toBeCloseTo(1, 5);
  });

  it("returns an empty tree when no window frame is available", () => {
    const tree = adaptFullHierarchyToDescribeResult({ windows: [{ className: "UIWindow" }] });
    expect(tree.children).toHaveLength(0);
  });

  // A testID container whose visible text lives in a child node (a counter whose
  // number is a `<Text>`): the flat shape emits the two as siblings, so the
  // container's own text is empty. `subtreeText` hoists the child text up so a
  // `text` assert against the container reads what it shows.
  it("hoists a testID container's child text into subtreeText", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "square-#d97973",
              windowFrame: { x: 24, y: 304, width: 100, height: 100 },
              children: [
                {
                  className: "RCTTextView",
                  label: "1",
                  windowFrame: { x: 60, y: 340, width: 20, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    const square = findAll(tree, { identifier: "square-#d97973" });
    expect(square[0]!.label).toBeUndefined(); // its own text is still empty
    expect(square[0]!.subtreeText).toBe("1"); // ...but the child's text is hoisted

    // End to end: the `text` condition against the container now passes —
    // `contains` (default) and exact `equals` both hold for the single "1".
    expect(evaluateCondition("text", "1", square)).toBe(true);
    expect(evaluateCondition("text", "1", square, "equals")).toBe(true);
    // Exact `equals` rejects a partial expectation the substring would accept.
    expect(evaluateCondition("text", "1", square, "contains")).toBe(true);
    expect(evaluateCondition("text", "Taps: 1", square, "equals")).toBe(false);
  });

  // The classic contains-vs-equals split: a counter reading "10" satisfies a
  // `contains: "1"` substring but not an `equals: "1"` exact match.
  it("distinguishes contains from equals on the hoisted text", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "counter",
              windowFrame: { x: 24, y: 304, width: 100, height: 100 },
              children: [
                {
                  className: "RCTTextView",
                  label: "10",
                  windowFrame: { x: 60, y: 340, width: 30, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);
    const counter = findAll(tree, { identifier: "counter" });

    expect(evaluateCondition("text", "1", counter, "contains")).toBe(true); // "10" contains "1"
    expect(evaluateCondition("text", "1", counter, "equals")).toBe(false); // "10" ≠ "1"
    expect(evaluateCondition("text", "10", counter, "equals")).toBe(true);
  });

  // Visibility: text hoists only from on-screen nodes. A ScrollView keeps all
  // rows mounted, so a far-below-the-fold row is in the dump with an off-screen
  // frame — its text must not satisfy a `text` assert against the container.
  it("does not hoist text from off-screen descendants", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTScrollView",
              identifier: "feed",
              windowFrame: SCREEN,
              children: [
                {
                  className: "RCTTextView",
                  label: "Row 1",
                  windowFrame: { x: 0, y: 100, width: 400, height: 40 },
                  children: [],
                },
                {
                  className: "RCTTextView",
                  label: "Row 50",
                  windowFrame: { x: 0, y: 5000, width: 400, height: 40 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);
    const feed = findAll(tree, { identifier: "feed" });

    // The visible row still hoists; the off-screen one does not.
    expect(feed[0]!.subtreeText).toBe("Row 1");
    expect(evaluateCondition("text", "Row 1", feed)).toBe(true);
    expect(evaluateCondition("text", "Row 50", feed)).toBe(false);
  });

  // Scoping: text belongs to its NEAREST identified ancestor. A self-identified
  // descendant claims its own text, so an outer container does not swallow it —
  // otherwise a screen-root testID would match any text anywhere beneath it.
  it("does not let an outer container swallow a self-identified descendant's text", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "outer",
              windowFrame: { x: 0, y: 0, width: 200, height: 200 },
              children: [
                {
                  className: "RCTView",
                  identifier: "inner",
                  windowFrame: { x: 0, y: 0, width: 100, height: 100 },
                  children: [
                    {
                      className: "RCTTextView",
                      label: "42",
                      windowFrame: { x: 10, y: 10, width: 20, height: 24 },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    expect(findAll(tree, { identifier: "inner" })[0]!.subtreeText).toBe("42");
    expect(findAll(tree, { identifier: "outer" })[0]!.subtreeText).toBeUndefined();
  });
});
