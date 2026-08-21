import { describe, it, expect } from "vitest";
import {
  tvFocusTree,
  isEmptyFocus,
  TV_FOCUS_WAIT_EMPTY_HINT,
} from "../src/tools/describe/platforms/tv-focus";
import type { TvDescribeResponse } from "../src/blueprints/tv-control-types";
import { findAll, isVisible, firstInReadingOrder } from "../src/utils/ui-tree-match";

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

describe("tvFocusTree — the focus view as a describe tree", () => {
  it("keeps the real frames the daemon reports", () => {
    // The frames were always in the payload; only the TS type and describe's
    // rendering dropped them. Using them means isVisible and reading order mean
    // the same thing here as on a phone.
    const first = tvFocusTree(SETTINGS).tree.children[0]!;

    expect(first.frame).toEqual({ x: 0.552, y: 0.175, width: 0.406, height: 0.061 });
    expect(isVisible(first)).toBe(true);
  });

  it("falls back to an ordered, non-degenerate frame when a backend reports none", () => {
    // Android TV's focus view genuinely has no bounds, and the tvOS daemon omits
    // the frame for a zero-size element. Neither may end up invisible or
    // unordered.
    const noFrames: TvDescribeResponse = {
      focused: null,
      focusable: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
    };

    const nodes = tvFocusTree(noFrames).tree.children;

    expect(nodes.every((n) => n.frame.width > 0 && n.frame.height > 0)).toBe(true);
    expect(nodes.every(isVisible)).toBe(true);
    expect(nodes.map((n) => n.frame.y)).toEqual([0, 1 / 3, 2 / 3]);
    expect(firstInReadingOrder(nodes)?.label).toBe("One");
  });

  it("carries the app id on the root so a whole-app swap is noticed", () => {
    const { tree } = tvFocusTree(SETTINGS);

    expect(tree.label).toBe("com.apple.TVSettings");
    // …but the root itself must not be matchable, or every selector would hit it.
    expect(findAll(tree, { text: "com.apple.TVSettings" })).toHaveLength(0);
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
    expect(empty.hint).toMatch(/launching|transition/i);
  });

  it("does not tell the agent to use describe instead — the wait tool works now", () => {
    // The old tvOS note redirected to describe/tv-remote because nothing else
    // worked. Repeating that here would be advice to abandon a tool that has
    // just been fixed.
    const empty = tvFocusTree({ focused: null, focusable: [] });

    expect(empty.hint).not.toMatch(/accessibility service does not support/i);
  });

  it("never attaches a hint to a populated read", () => {
    expect(tvFocusTree(SETTINGS).hint).toBeUndefined();
  });
});
