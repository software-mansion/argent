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

  it("hides the text inside a scrolled-away row, whatever frame the daemon gives it", () => {
    // Captured from Settings > General: an off-screen cell's children are reported
    // at y=154, on screen.
    const { tree } = tvFocusTree(
      FOCUS,
      hierarchy([
        {
          label: "Time Zone",
          frame: { x: 1060, y: 2187, width: 780, height: 66 },
          children: [{ label: "Warsaw", frame: { x: 1060, y: 154, width: 130, height: 46 } }],
        },
      ])
    );

    const matches = findAll(tree, { text: "Warsaw" });
    expect(matches).toHaveLength(1);
    expect(evaluateCondition("visible", undefined, matches)).toBe(false);
    expect(evaluateCondition("hidden", undefined, matches)).toBe(true);
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
    const { tree } = tvFocusTree(
      { focused: null, focusable: [] },
      hierarchy([{ label: "Stale", isFocused: true } as TvHierarchyNode])
    );

    expect(hasTvCursor(tree)).toBe(false);
    expect(findAll(tree, { role: "focused" })).toHaveLength(0);
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

  it("does not tell the agent to use describe instead — the wait tool works now", () => {
    // The old tvOS note redirected to describe/tv-remote because nothing else
    // worked. Repeating that here would be advice to abandon a tool that has
    // just been fixed.
    const empty = tvFocusTree({ focused: null, focusable: [] });

    expect(empty.hint).not.toMatch(/accessibility service does not support/i);
  });

  it("says neither that the app must be launching nor to call describe", () => {
    // A static screen with nothing on it stays this way, and describe's respawn
    // changes nothing there.
    const { hint } = tvFocusTree({ focused: null, focusable: [] });

    expect(hint).not.toMatch(/call `describe`/);
    expect(hint).toMatch(/may be launching/);
  });

  it("never attaches a hint to a populated read", () => {
    expect(tvFocusTree(SETTINGS).hint).toBeUndefined();
  });
});
