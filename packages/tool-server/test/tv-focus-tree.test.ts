import { describe, it, expect } from "vitest";
import {
  tvFocusTree,
  hasTvCursor,
  isEmptyFocus,
  TV_FOCUS_WAIT_EMPTY_HINT,
} from "../src/tools/describe/platforms/tv-focus";
import type {
  TvDescribeResponse,
  TvHierarchyNode,
  TvHierarchyResponse,
} from "../src/blueprints/tv-control-types";
import { evaluateCondition, findAll, isVisible } from "../src/utils/ui-tree-match";

/**
 * The adapter behind issue #620: `describeIos` short-circuits every tvOS read to
 * an empty tree, so the wait tools could never settle or match on an Apple TV.
 * This turns the focus view — the source `describe` already uses successfully —
 * into a tree they can poll.
 *
 * Payloads below mirror a real tvOS daemon response (captured from
 * com.apple.TVSettings): normalized frames, compound traits, values on rows.
 */

const SETTINGS: TvDescribeResponse = {
  bundleId: "com.apple.TVSettings",
  focused: {
    label: "About",
    frame: { x: 0.552, y: 0.175, width: 0.406, height: 0.061 },
    traits: ["button", "_focusGuide"],
    isFocused: true,
  },
  focusable: [
    {
      label: "About",
      frame: { x: 0.552, y: 0.175, width: 0.406, height: 0.061 },
      traits: ["button", "_focusGuide"],
      isFocused: true,
    },
    {
      label: "Appearance",
      value: "Dark",
      frame: { x: 0.552, y: 0.249, width: 0.406, height: 0.061 },
      traits: ["button", "_focusGuide"],
    },
    {
      label: "Region",
      value: "Poland",
      frame: { x: 0.552, y: 0.323, width: 0.406, height: 0.061 },
      traits: ["button", "_focusGuide"],
    },
  ],
};

function row(label: string) {
  return { label, frame: { x: 0.5, y: 0.5, width: 0.4, height: 0.06 }, traits: ["button"] };
}

describe("tvFocusTree — the focus view as a describe tree", () => {
  it("keeps the real frames the daemon reports", () => {
    // The frames were always in the payload; only the TS type and describe's
    // rendering dropped them. Using them means isVisible and reading order mean
    // the same thing here as on a phone.
    const first = tvFocusTree(SETTINGS).tree.children[0]!;

    expect(first.frame).toEqual({ x: 0.552, y: 0.175, width: 0.406, height: 0.061 });
    expect(isVisible(first)).toBe(true);
  });

  it("keeps a frameless element zero-area, so `visible` and `hidden` read it as gone", () => {
    // The daemon omits the frame only for a zero-size element, and the tool
    // description promises `hidden` accepts a zero-area match.
    const { tree } = tvFocusTree({
      focused: null,
      focusable: [{ label: "Collapsed" }, row("Shown")],
    });

    const [collapsed, shown] = tree.children;
    expect(collapsed!.frame).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(isVisible(collapsed!)).toBe(false);
    expect(isVisible(shown!)).toBe(true);
  });

  it("keeps a scrolled-away row matchable but not visible", () => {
    // Captured from General in com.apple.TVSettings: the daemon keeps listing a
    // row below the fold. A row the fold cuts through is still on screen.
    const { tree } = tvFocusTree({
      focused: null,
      focusable: [
        { label: "Below", frame: { x: 0.552, y: 1.069, width: 0.406, height: 0.061 } },
        { label: "Cut", frame: { x: 0.552, y: 0.994, width: 0.406, height: 0.061 } },
      ],
    });

    const [below, cut] = tree.children;
    expect(findAll(tree, { text: "Below" })).toHaveLength(1);
    expect(isVisible(below!)).toBe(false);
    expect(isVisible(cut!)).toBe(true);
  });

  it("does not make the app id matchable", () => {
    expect(findAll(tvFocusTree(SETTINGS).tree, { text: "com.apple.TVSettings" })).toHaveLength(0);
  });

  it("exposes labels, values and traits to the selector matcher", () => {
    const { tree } = tvFocusTree(SETTINGS);

    expect(findAll(tree, { text: "Appearance" })).toHaveLength(1);
    // Values matter: a settings row's state lives there, and `condition: "text"`
    // reads it.
    expect(findAll(tree, { text: "Dark" })).toHaveLength(1);
    expect(findAll(tree, { role: "button" })).toHaveLength(3);
  });

  it("marks the cursor so it is both selectable and fingerprinted", () => {
    const { tree } = tvFocusTree(SETTINGS);

    const focused = findAll(tree, { role: "focused" });
    expect(focused).toHaveLength(1);
    expect(focused[0]!.label).toBe("About");
    // The field is set too, so format-tree renders [focused] as on Vega.
    expect(focused[0]!.focused).toBe(true);
    // And it lands in `role`, which the idle fingerprint hashes — so a cursor
    // move alone makes the screen unsettled.
    expect(focused[0]!.role).toContain("focused");
  });

  it("does not duplicate the cursor when it also appears in the focusable list", () => {
    // `focused` and its twin in `focusable` arrive as separate objects from the
    // same JSON, so an identity check would append a second copy and the cursor
    // would match twice.
    const { tree } = tvFocusTree(SETTINGS);

    expect(tree.children).toHaveLength(3);
    expect(tree.children.filter((c) => c.role.includes("focused"))).toHaveLength(1);
  });

  it("still surfaces a cursor that is missing from the focusable list", () => {
    const orphan: TvDescribeResponse = {
      focused: { label: "Orphan", traits: ["button"], isFocused: true },
      focusable: [{ label: "Other", traits: ["button"] }],
    };

    const { tree } = tvFocusTree(orphan);

    expect(tree.children).toHaveLength(2);
    expect(findAll(tree, { text: "Orphan", role: "focused" })).toHaveLength(1);
  });

  it("does not count a cursor missing from the list as landed", () => {
    // The tvOS keyboard closing: `done` keeps focus for about 550 ms after the
    // keyboard's focusable elements are gone.
    const closing = tvFocusTree({
      focused: { label: "done", traits: ["button"], isFocused: true },
      focusable: [],
    });

    expect(findAll(closing.tree, { text: "done", role: "focused" })).toHaveLength(1);
    expect(hasTvCursor(closing)).toBe(false);
    expect(hasTvCursor(tvFocusTree(SETTINGS))).toBe(true);
  });

  it("marks a cursor missing from the list even when the read did not", () => {
    const { tree } = tvFocusTree({
      focused: { label: "Orphan", traits: ["button"] },
      focusable: [{ label: "Other", traits: ["button"] }],
    });

    expect(findAll(tree, { text: "Orphan", role: "focused" })).toHaveLength(1);
  });
});

describe("tvFocusTree — compound labels", () => {
  const compound = (): TvDescribeResponse => ({
    focused: null,
    focusable: [{ ...row("x"), label: "Home\nLander\nSide bar content item\n1 of 5\nselected" }],
  });

  it("compares `equals` against the name describe shows", () => {
    const matches = findAll(tvFocusTree(compound()).tree, { text: "Home" });

    expect(matches).toHaveLength(1);
    expect(evaluateCondition("text", "Home", matches, "equals")).toBe(true);
  });

  it("still finds the context, by selector and by `contains`", () => {
    const { tree } = tvFocusTree(compound());

    expect(findAll(tree, { text: "selected" })).toHaveLength(1);
    expect(evaluateCondition("text", "Lander", findAll(tree, { text: "Home" }), "contains")).toBe(
      true
    );
  });
});

describe("tvFocusTree — the rest of the screen", () => {
  const screenFrame = { width: 1920, height: 1080 };
  const FOCUS: TvDescribeResponse = {
    focused: null,
    focusable: [{ ...row("Only"), isFocused: true }],
  };
  const hierarchy = (children: TvHierarchyNode[]): TvHierarchyResponse => ({
    screenFrame,
    tree: { label: "AppName", frame: { x: 0, y: 0, ...screenFrame }, children },
  });
  const LOADING: TvHierarchyNode = {
    label: "Loading 7",
    traits: ["staticText"],
    frame: { x: 192, y: 108, width: 960, height: 54 },
  };

  it("adds non-focusable text, with a normalized frame", () => {
    const { tree } = tvFocusTree(FOCUS, hierarchy([LOADING]));

    const [node] = findAll(tree, { text: "Loading" });
    expect(node!.frame).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.05 });
    expect(isVisible(node!)).toBe(true);
  });

  it("does not make the app itself matchable, or duplicate a focusable", () => {
    const { tree } = tvFocusTree(
      FOCUS,
      hierarchy([
        { label: "Only", isFocused: true, children: [{ label: "Only" }] } as TvHierarchyNode,
      ])
    );

    expect(findAll(tree, { text: "AppName" })).toHaveLength(0);
    expect(findAll(tree, { text: "Only" })).toHaveLength(1);
  });

  it("leaves the cursor to the focus view", () => {
    const read = tvFocusTree(
      { focused: null, focusable: [] },
      hierarchy([{ label: "Stale", isFocused: true } as TvHierarchyNode])
    );

    expect(hasTvCursor(read)).toBe(false);
    expect(findAll(read.tree, { role: "focused" })).toHaveLength(0);
  });

  // Frames and trait bits below were read on an Apple TV 4K simulator, tvOS 27.
  const pt = (x: number, y: number, width: number, height: number) => ({
    x: x / screenFrame.width,
    y: y / screenFrame.height,
    width: width / screenFrame.width,
    height: height / screenFrame.height,
  });

  it("counts a cursor inside an element read as one item as landed", () => {
    // A card that accessibility treats as one element, with two buttons in it:
    // the focused button is never listed, and the card is on screen around it.
    const card = tvFocusTree(
      {
        focused: {
          label: "Play",
          traits: ["button", "_focusGuide"],
          _traitsHex: "0x200000001",
          isFocused: true,
          frame: pt(636, 488.6, 288, 102.9),
        },
        focusable: [],
      },
      hierarchy([{ label: "Card", frame: { x: 560, y: 340, width: 800, height: 400 } }])
    );

    expect(hasTvCursor(card)).toBe(true);
  });

  it("does not count the keyboard's cursor as landed while it opens or closes", () => {
    const field: TvHierarchyNode = {
      value: "Name",
      frame: { x: 556, y: 299.6, width: 808, height: 80.8 },
      children: [],
    };
    // Closing: `done` keeps focus after the keyboard has left the hierarchy.
    const closing = tvFocusTree(
      {
        focused: {
          label: "done",
          traits: ["button", "_focusGuide"],
          _traitsHex: "0x200000001",
          isFocused: true,
          frame: pt(893, 798, 133, 63),
        },
        focusable: [],
      },
      // tvOS 27.2: the form's Profile label covers the keyboard button's old
      // position. The enclosing layout view does too. Neither owns the button.
      hierarchy([
        {
          frame: { x: 50, y: 50, width: 1820, height: 980 },
          children: [
            {
              label: "Profile",
              traits: ["staticText"],
              frame: { x: 80, y: 80, width: 1760, height: 920 },
            },
            field,
          ],
        },
      ])
    );
    // Opening: the text field keeps focus while only the keyboard is listed,
    // and a wrapper around the field is larger than it.
    const opening = tvFocusTree(
      {
        focused: {
          value: "Name",
          traits: ["_focusGuide"],
          _traitsHex: "0x2200240000",
          isFocused: true,
          frame: pt(556, 299.6, 808, 80.8),
        },
        focusable: [
          { label: "Keyboard", traits: ["_focusGuide"], frame: pt(0, 462, 1920, 226) },
          { label: "done", traits: ["button", "_focusGuide"], frame: pt(893, 798, 133, 63) },
        ],
      },
      hierarchy([{ frame: { x: 540, y: 290, width: 840, height: 100 }, children: [field] }])
    );

    expect(hasTvCursor(closing)).toBe(false);
    expect(hasTvCursor(opening)).toBe(false);
  });

  it("waits for focus on a returning form even if a card covers the old key", () => {
    const closing = tvFocusTree(
      { focused: { label: "done", frame: pt(893, 798, 133, 63) }, focusable: [] },
      hierarchy([
        { label: "Profile card", frame: { x: 80, y: 80, width: 1760, height: 920 } },
        {
          label: "Name",
          _traitsHex: "0x2200040000",
          frame: { x: 496, y: 310, width: 808, height: 91 },
        },
      ])
    );

    expect(hasTvCursor(closing)).toBe(false);
  });

  it("keeps `role` to what the remote can reach", () => {
    // Settings' disabled chevrons carry `button`; `hidden {role:"button"}` must
    // not wait on them.
    const { tree } = tvFocusTree(
      FOCUS,
      hierarchy([{ label: "chevron", traits: ["button", "notEnabled"] }])
    );

    expect(findAll(tree, { role: "button" }).map((n) => n.label)).toEqual(["Only"]);
    expect(findAll(tree, { text: "chevron" })).toHaveLength(1);
  });

  it("marks a hierarchy cut at the daemon's node cap as partial", () => {
    const capped = { ...hierarchy([LOADING]), nodeCount: 801 };

    expect(tvFocusTree(FOCUS, capped).partial).toBe(true);
    expect(tvFocusTree(FOCUS, { ...capped, nodeCount: 800 }).partial).toBeUndefined();
  });

  it("judges a screen with text and nothing focusable, with no hint", () => {
    const res = tvFocusTree({ focused: null, focusable: [] }, hierarchy([LOADING]));

    expect(res.tree.children).toHaveLength(1);
    expect(res.hint).toBeUndefined();
  });

  it("stays blind when the hierarchy has only unlabelled views", () => {
    const res = tvFocusTree(
      { focused: null, focusable: [] },
      hierarchy([{ frame: { x: 0, y: 0, ...screenFrame } }])
    );

    expect(res.tree.children).toHaveLength(0);
    expect(res.hint).toBe(TV_FOCUS_WAIT_EMPTY_HINT);
  });
});

describe("tvFocusTree — the empty read", () => {
  it("is empty only when nothing actionable was reported", () => {
    expect(isEmptyFocus({ focused: null, focusable: [] })).toBe(true);
    // A cursor with no enumerable siblings is still something to act on.
    expect(isEmptyFocus({ focused: { label: "X" }, focusable: [] })).toBe(false);
  });

  it("attaches a hint, which is what stops `hidden` false-passing", () => {
    // Load-bearing, not decoration: await-ui-element treats an empty tree as an
    // untrustworthy read ONLY when a hint says so. Without this, a wait for
    // `hidden` would succeed on the first poll of a still-launching app and
    // release a gated interaction.
    const empty = tvFocusTree({ focused: null, focusable: [] });

    expect(empty.tree.children).toHaveLength(0);
    expect(empty.hint).toBe(TV_FOCUS_WAIT_EMPTY_HINT);
  });

  it("never attaches a hint to a populated read", () => {
    expect(tvFocusTree(SETTINGS).hint).toBeUndefined();
  });
});
