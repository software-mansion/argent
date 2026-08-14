import { describe, it, expect } from "vitest";
import { adaptFullHierarchyToDescribeResult } from "../src/tools/flows/flow-ios-tree";
import {
  assertText,
  evaluateCondition,
  findAll,
  nodeAtPoint,
  selectorToFrame,
  treeFingerprint,
} from "../src/utils/ui-tree-match";

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

  it("keeps unlabelled controls that are selectable by role", () => {
    const raw = payload();
    raw.windows[0]!.children[0]!.children.push({
      className: "UIButton",
      windowFrame: { x: 240, y: 440, width: 100, height: 44 },
      children: [],
    });
    raw.windows[0]!.children[0]!.children.push({
      className: "UISlider",
      windowFrame: { x: 40, y: 520, width: 320, height: 44 },
      children: [],
    });

    const tree = adaptFullHierarchyToDescribeResult(raw);
    expect(findAll(tree, { role: "AXButton" })).toHaveLength(1);
    expect(findAll(tree, { role: "AXAdjustable" })).toHaveLength(1);
    // The anonymous RCTView already in the fixture remains pruned.
    expect(tree.children).toHaveLength(5);
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

  // A labelled container whose child renders the same text (a testID button
  // with accessibilityLabel "Submit" over a `<Text>Submit</Text>`) must not
  // hoist the duplicate — "Submit Submit" would fail an `equals` assert
  // against exactly what the screen shows.
  it("does not duplicate a container's own label that its child also renders", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "submit-button",
              label: "Submit",
              windowFrame: { x: 24, y: 304, width: 200, height: 48 },
              children: [
                {
                  className: "RCTTextView",
                  label: "Submit",
                  windowFrame: { x: 80, y: 316, width: 88, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);
    const submit = findAll(tree, { identifier: "submit-button" });

    // The child text adds nothing over the own label, so nothing is stamped
    // and the assert reads the node's own "Submit" — not "Submit Submit".
    expect(submit[0]!.subtreeText).toBeUndefined();
    expect(assertText(submit[0]!)).toBe("Submit");
    expect(evaluateCondition("text", "Submit", submit, "equals")).toBe(true);
  });

  // The dedup is word-boundary, NOT substring: an accessibilityLabel "Save"
  // over a `<Text>Saved successfully</Text>` shows both texts — "Save" only
  // appears inside the word "Saved" — so the label stays in the hoist and an
  // `equals: "Save"` assert against the container passes.
  it("keeps an own label that only appears inside a descendant word", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "save-button",
              label: "Save",
              windowFrame: { x: 24, y: 304, width: 200, height: 48 },
              children: [
                {
                  className: "RCTTextView",
                  label: "Saved successfully",
                  windowFrame: { x: 40, y: 316, width: 168, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);
    const save = findAll(tree, { identifier: "save-button" });

    expect(save[0]!.subtreeText).toBe("Save Saved successfully");
    expect(evaluateCondition("text", "Save", save, "equals")).toBe(true);
    expect(evaluateCondition("text", "Saved successfully", save, "contains")).toBe(true);
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

  // Scroll-clip prune: a row scrolled out of a mid-screen UIScrollView's
  // window sits below the scroller's fold with an on-screen windowFrame. The
  // AX describe path never reports it, so the flow tree must exclude it too —
  // node, tap point, and hoisted text — or `assert { hidden }` falsely fails
  // and a tap resolves outside the visible scroller.
  it("excludes a label scrolled out of a mid-screen UIScrollView", () => {
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
              windowFrame: { x: 0, y: 300, width: 400, height: 200 },
              children: [
                {
                  // The content view spans past the viewport — a direct child
                  // of the scroller that must survive its partial overlap.
                  className: "RCTScrollContentView",
                  windowFrame: { x: 0, y: 300, width: 400, height: 800 },
                  children: [
                    {
                      className: "RCTTextView",
                      label: "Row 1",
                      windowFrame: { x: 0, y: 320, width: 400, height: 40 },
                      children: [],
                    },
                    {
                      // Below the 500pt fold, inside the 800pt screen.
                      className: "RCTTextView",
                      label: "Row 9",
                      windowFrame: { x: 0, y: 560, width: 400, height: 40 },
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

    expect(findAll(tree, { text: "Row 1" })).toHaveLength(1);
    const clipped = findAll(tree, { text: "Row 9" });
    expect(clipped).toHaveLength(0);
    expect(evaluateCondition("hidden", undefined, clipped)).toBe(true);
    expect(evaluateCondition("visible", undefined, clipped)).toBe(false);
    expect(selectorToFrame(tree, { text: "Row 9" })).toBeUndefined();

    // The clipped row's text is NOT hoisted onto the scroller.
    const feed = findAll(tree, { identifier: "feed" });
    expect(feed[0]!.subtreeText).toBe("Row 1");
    expect(evaluateCondition("text", "Row 9", feed)).toBe(false);
  });

  // Partial overlap keeps the node with its full (screen-clipped-only) frame,
  // mirroring the Android describe path's partial-overlap handling.
  it("keeps a label partially inside the scroll window", () => {
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
              windowFrame: { x: 0, y: 300, width: 400, height: 200 },
              children: [
                {
                  className: "RCTTextView",
                  label: "Row 5",
                  // Straddles the 500pt fold: 480–520.
                  windowFrame: { x: 0, y: 480, width: 400, height: 40 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    const partial = findAll(tree, { text: "Row 5" })[0]!;
    expect(partial).toBeDefined();
    expect(partial.frame.y).toBeCloseTo(480 / 800, 5);
    expect(partial.frame.height).toBeCloseTo(40 / 800, 5);
  });

  // Only scrollable ancestors clip: a badge hanging outside its plain parent
  // (a notification dot on a card) must not be pruned.
  it("keeps a badge overflowing a non-scrollable parent", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTView",
              identifier: "card",
              windowFrame: { x: 40, y: 300, width: 320, height: 100 },
              children: [
                {
                  className: "RCTView",
                  identifier: "badge",
                  label: "3 unread",
                  // Entirely outside the card's frame, on screen.
                  windowFrame: { x: 340, y: 270, width: 40, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    const badge = findAll(tree, { identifier: "badge" });
    expect(badge).toHaveLength(1);
    expect(badge[0]!.frame.y).toBeCloseTo(270 / 800, 5);
  });

  // Nested scroll clips COMPOSE (intersect) rather than replace: a
  // content-sized UICollectionView straddles the outer RCTScrollView's fold.
  // Its own window frame must not re-admit cells the outer viewport has
  // clipped — a cell inside the collection's rect but below the outer fold is
  // invisible and must be dropped.
  it("drops a cell below the outer fold inside a content-sized inner scroller", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "RCTScrollView",
              identifier: "page",
              // Outer viewport y[200,500].
              windowFrame: { x: 0, y: 200, width: 400, height: 300 },
              children: [
                {
                  className: "RCTScrollContentView",
                  windowFrame: { x: 0, y: 200, width: 400, height: 1200 },
                  children: [
                    {
                      // Content-sized: extends to y=1100, past the 500pt fold.
                      className: "UICollectionView",
                      identifier: "grid",
                      windowFrame: { x: 0, y: 200, width: 400, height: 900 },
                      children: [
                        {
                          className: "RCTTextView",
                          label: "Cell 1",
                          windowFrame: { x: 0, y: 220, width: 400, height: 40 },
                          children: [],
                        },
                        {
                          // Inside the grid's rect and the 800pt screen, but
                          // below the outer scroller's 500pt fold.
                          className: "RCTTextView",
                          label: "Cell 9",
                          windowFrame: { x: 0, y: 560, width: 400, height: 40 },
                          children: [],
                        },
                      ],
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

    // The in-viewport cell resolves; the straddling grid survives its partial
    // overlap.
    expect(findAll(tree, { text: "Cell 1" })).toHaveLength(1);
    expect(findAll(tree, { identifier: "grid" })).toHaveLength(1);
    const below = findAll(tree, { text: "Cell 9" });
    expect(below).toHaveLength(0);
    expect(evaluateCondition("hidden", undefined, below)).toBe(true);
    expect(evaluateCondition("visible", undefined, below)).toBe(false);
    expect(selectorToFrame(tree, { text: "Cell 9" })).toBeUndefined();
    // ...and the clipped cell's text is not hoisted onto the grid.
    expect(findAll(tree, { identifier: "grid" })[0]!.subtreeText).toBe("Cell 1");
  });

  // Cell classes contain the TableView/CollectionView substrings but do not
  // scroll their content. Reporting them as AXScrollArea made every row a
  // scroll container, and the edge-avoid nudge's smallest-containing-scroller
  // resolution then picked the cell over its list - see targetScrollerFrame.
  it("classifies cell classes as cells, not scroll areas", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "UITableView",
              identifier: "list",
              windowFrame: SCREEN,
              children: [
                {
                  className: "UITableViewCell",
                  identifier: "cell",
                  windowFrame: { x: 0, y: 100, width: 400, height: 50 },
                  children: [
                    {
                      className: "UITableViewCellContentView",
                      identifier: "cell-content",
                      windowFrame: { x: 0, y: 100, width: 400, height: 50 },
                      children: [
                        {
                          className: "UILabel",
                          label: "Row 14",
                          windowFrame: { x: 16, y: 110, width: 200, height: 30 },
                          children: [],
                        },
                      ],
                    },
                  ],
                },
                {
                  // SwiftUI List / collection cells hit the same substrings.
                  className: "ListTableViewCell",
                  identifier: "swiftui-cell",
                  windowFrame: { x: 0, y: 150, width: 400, height: 50 },
                  children: [],
                },
                {
                  className: "AnyListCollectionViewCell",
                  identifier: "swiftui-collection-cell",
                  windowFrame: { x: 0, y: 200, width: 400, height: 50 },
                  children: [],
                },
                {
                  className: "UICollectionViewCell",
                  identifier: "grid-cell",
                  windowFrame: { x: 0, y: 250, width: 400, height: 50 },
                  children: [],
                },
              ],
            },
            {
              className: "UICollectionView",
              identifier: "grid",
              windowFrame: { x: 0, y: 400, width: 400, height: 200 },
              children: [],
            },
            {
              className: "UIScrollView",
              identifier: "pane",
              windowFrame: { x: 0, y: 600, width: 400, height: 200 },
              children: [],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    // The scrollers themselves keep the role...
    for (const id of ["list", "grid", "pane"]) {
      expect(findAll(tree, { identifier: id })[0]!.role).toBe("AXScrollArea");
    }
    // ...while every row shape is a cell...
    for (const id of ["cell", "swiftui-cell", "swiftui-collection-cell", "grid-cell"]) {
      expect(findAll(tree, { identifier: id })[0]!.role).toBe("AXCell");
    }
    // ...and a row's internals stay a plain group.
    expect(findAll(tree, { identifier: "cell-content" })[0]!.role).toBe("AXGroup");
  });

  // UIKit class names are suffix-typed, so the tail names the kind of view, and
  // the cell and scroller tests both read it. Reading either word anywhere in
  // the name is wrong at both ends: it promotes a row's internals to a row and
  // demotes genuine scrollers whose name happens to carry "Cell".
  it("keys the cell and scroll-area roles on the class name suffix, not on a substring", () => {
    const cases: [string, string][] = [
      // Plain scrollers.
      ["UIScrollView", "AXScrollArea"],
      ["UITableView", "AXScrollArea"],
      ["UICollectionView", "AXScrollArea"],
      // Rows: they do not scroll, and they are not scaffolding either - a stock
      // one carries no id and no label, so only their own role keeps them.
      ["UITableViewCell", "AXCell"],
      ["UICollectionViewCell", "AXCell"],
      ["SwiftUI.ListCollectionViewCell", "AXCell"],
      ["MyPhotoCell", "AXCell"],
      // A row's internals and a list's chrome: neither a row nor a scroller.
      ["UITableViewCellContentView", "AXGroup"],
      ["_UITableViewCellSeparatorView", "AXGroup"],
      ["UITableViewWrapperView", "AXGroup"],
      ["_UIScrollViewScrollIndicator", "AXGroup"],
      // Genuine scrollers a "Cell" test on the whole name would demote: UIKit's
      // swipe-actions scroller under a row, and an app's own class.
      ["UITableViewCellScrollView", "AXScrollArea"],
      ["PhotoCellCollectionView", "AXScrollArea"],
      // A Swift GENERIC class arrives mangled with its type arguments after the
      // class name (here SwiftUI's ScrollView backing view, and a List cell);
      // a plain Swift class still ends with it.
      ["_TtGC7SwiftUI19UIHostingScrollViewVS_7AnyView_", "AXScrollArea"],
      ["_TtGC7SwiftUI22ListCollectionViewCellVS_7AnyView_", "AXCell"],
      ["_TtC7SwiftUI33UpdateCoalescingCollectionView", "AXScrollArea"],
    ];
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: cases.map(([className], i) => ({
            className,
            identifier: `v${i}`,
            windowFrame: { x: 0, y: i * 40, width: 400, height: 40 },
            children: [],
          })),
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    const actual = cases.map(([className], i): [string, string | undefined] => [
      className,
      findAll(tree, { identifier: `v${i}` })[0]!.role,
    ]);
    expect(actual).toEqual(cases);
  });

  // The role is not cosmetic - it is what carries a row past the leaf gate. A
  // stock UIKit cell has no identifier and no label, so any role the gate treats
  // as scaffolding drops the whole row: the list's rows leave the flow tree, and
  // a tap on a row's dead space resolves to the list that covers the screen.
  it("emits an anonymous cell of every form as a leaf", () => {
    const forms = [
      "UITableViewCell",
      "UICollectionViewCell",
      "SwiftUI.ListCollectionViewCell",
      "_TtGC7SwiftUI22ListCollectionViewCellVS_7AnyView_",
      "MyPhotoCell",
    ];
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "UITableView",
              identifier: "list",
              windowFrame: SCREEN,
              children: forms.map((className, i) => ({
                className,
                // No identifier, no label - exactly what UIKit reports.
                windowFrame: { x: 0, y: 100 + i * 100, width: 400, height: 100 },
                children: [],
              })),
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);

    expect(findAll(tree, { role: "AXCell" })).toHaveLength(forms.length);
    // ...and the row is what a tap on its dead space finds, not the list.
    const hit = nodeAtPoint(tree, { x: 0.75, y: 0.306 });
    expect(hit?.role).toBe("AXCell");
    expect(hit?.frame.y).toBeCloseTo(200 / 800, 5); // the second row, at y=200
  });

  // An anonymous cell clears the leaf gate on its own role, so it carries the
  // list's motion into treeFingerprint - the end-of-scroll and settle signal.
  // A row class that is NOT a cell still needs something nameable in it.
  it("fingerprints a list through anonymous cells, and a non-cell row through its children", () => {
    const rows = (
      rowClass: string,
      offset: number,
      children: (row: number, y: number) => unknown[]
    ): unknown => ({
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "UITableView",
              identifier: "list",
              windowFrame: SCREEN,
              children: [0, 1].map((row) => {
                const y = 100 + row * 100 - offset;
                return {
                  // No identifier, no label: named only by its class kind.
                  className: rowClass,
                  windowFrame: { x: 0, y, width: 400, height: 100 },
                  children: children(row, y),
                };
              }),
            },
          ],
        },
      ],
    });
    const named = (row: number, y: number): unknown[] => [
      {
        className: "UILabel",
        label: `Row ${row}`,
        windowFrame: { x: 16, y: y + 10, width: 200, height: 30 },
        children: [],
      },
      {
        className: "UIImageView",
        windowFrame: { x: 300, y: y + 10, width: 40, height: 40 },
        children: [],
      },
    ];
    const anonymous = (_row: number, y: number): unknown[] => [
      {
        className: "UIView",
        windowFrame: { x: 16, y: y + 10, width: 200, height: 30 },
        children: [],
      },
    ];

    // The list, both cells, and each row's text and image...
    const tree = adaptFullHierarchyToDescribeResult(rows("UITableViewCell", 0, named));
    expect(findAll(tree, { role: "AXCell" })).toHaveLength(2);
    expect(tree.children).toHaveLength(7);
    // ...all move with their row, so a scroll shows.
    expect(treeFingerprint(tree)).not.toBe(
      treeFingerprint(adaptFullHierarchyToDescribeResult(rows("UITableViewCell", 40, named)))
    );

    // The cells alone are enough: rows with nothing nameable inside them still
    // move the fingerprint.
    const bareCells = adaptFullHierarchyToDescribeResult(rows("UITableViewCell", 0, anonymous));
    expect(bareCells.children).toHaveLength(3);
    expect(treeFingerprint(bareCells)).not.toBe(
      treeFingerprint(adaptFullHierarchyToDescribeResult(rows("UITableViewCell", 40, anonymous)))
    );

    // The documented residual: a non-cell row class with nothing nameable
    // anywhere leaves only the list itself, whose frame does not move, so the
    // scroll reads as finished. Unnamed React Native and custom UIView rows
    // have always behaved this way.
    const bare = adaptFullHierarchyToDescribeResult(rows("RCTView", 0, anonymous));
    expect(bare.children).toHaveLength(1);
    expect(treeFingerprint(bare)).toBe(
      treeFingerprint(adaptFullHierarchyToDescribeResult(rows("RCTView", 40, anonymous)))
    );
  });

  // The scroll-clip flag rides on the same role, so a cell must not clip
  // either: a badge hanging outside its cell's rect (the overflowing-parent
  // shape above, with a Cell class name) stays in the tree.
  it("does not scroll-clip a child overflowing its cell", () => {
    const raw = {
      windows: [
        {
          className: "UIWindow",
          frame: SCREEN,
          windowFrame: SCREEN,
          children: [
            {
              className: "UITableViewCell",
              identifier: "cell",
              windowFrame: { x: 0, y: 300, width: 400, height: 50 },
              children: [
                {
                  className: "RCTView",
                  identifier: "badge",
                  label: "3 unread",
                  // Entirely outside the cell's frame, on screen.
                  windowFrame: { x: 360, y: 270, width: 40, height: 24 },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const tree = adaptFullHierarchyToDescribeResult(raw);
    expect(findAll(tree, { identifier: "badge" })).toHaveLength(1);
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
