import { describe, it, expect } from "vitest";
import { adaptFullHierarchyToDescribeResult } from "../src/tools/flows/flow-native-tree";
import { findAll, selectorToFrame } from "../src/utils/ui-tree-match";

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
});
