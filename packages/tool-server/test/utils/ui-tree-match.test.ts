import { describe, it, expect, vi } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import {
  nodeAtPoint,
  selectorToFrame,
  deriveSelector,
  evaluateCondition,
  findAll,
  identifierMatches,
  matchNode,
  textMatches,
  treeFingerprint,
  uiTreeMatchInternals,
} from "../../src/utils/ui-tree-match";

function node(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

const root = node({
  role: "AXGroup",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    node({
      role: "AXButton",
      label: "Login",
      identifier: "login-btn",
      frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    }),
    node({
      role: "AXStaticText",
      label: "Welcome back",
      frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
    }),
    node({
      // overlapping container around the button — larger area
      role: "AXGroup",
      frame: { x: 0, y: 0.05, width: 0.5, height: 0.2 },
      children: [],
    }),
  ],
});

describe("ui-tree-match", () => {
  it("nodeAtPoint returns the smallest element under a point", () => {
    // (0.2, 0.15) sits inside both the button and the surrounding group; the
    // button has the smaller area and wins.
    const hit = nodeAtPoint(root, { x: 0.2, y: 0.15 });
    expect(hit?.label).toBe("Login");
  });

  it("nodeAtPoint returns undefined when nothing is under the point", () => {
    expect(nodeAtPoint(root, { x: 0.95, y: 0.95 })).toBeUndefined();
  });

  it("selectorToFrame resolves the first visible match", () => {
    const frame = selectorToFrame(root, { text: "Welcome" });
    expect(frame).toMatchObject({ x: 0.1, y: 0.3 });
  });

  // iOS flattens an accessible container's descendants into its own label
  // (e.g. an RNGH Touchable wrapping nested layers), so a text selector
  // substring-matches the container as well as the leaf that carries the text.
  // Modeled on the nested-touchables example screen.
  const aggregated = node({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      node({
        role: "AXGroup",
        label: "Outer Touchable Inner tap gesture Inner Touchable",
        identifier: "outer-touchable",
        frame: { x: 0.18, y: 0.45, width: 0.64, height: 0.19 },
      }),
      node({
        role: "AXStaticText",
        label: "Outer Touchable",
        frame: { x: 0.37, y: 0.47, width: 0.26, height: 0.02 },
      }),
      node({
        role: "AXStaticText",
        label: "Inner tap gesture",
        frame: { x: 0.36, y: 0.52, width: 0.27, height: 0.02 },
      }),
      node({
        role: "AXGroup",
        label: "Inner Touchable",
        identifier: "inner-touchable",
        frame: { x: 0.28, y: 0.56, width: 0.45, height: 0.05 },
      }),
      node({
        role: "AXStaticText",
        label: "Inner Touchable",
        frame: { x: 0.37, y: 0.57, width: 0.25, height: 0.02 },
      }),
    ],
  });

  it("selectorToFrame prefers an exact label over a container whose aggregated label contains it", () => {
    // The outer AXGroup is topmost and substring-matches, but its centre sits
    // over a nested child; the exact-label leaf must win.
    const frame = selectorToFrame(aggregated, { text: "Outer Touchable" });
    expect(frame).toMatchObject({ x: 0.37, y: 0.47 });
  });

  it("selectorToFrame prefers the smallest of several exact matches", () => {
    // Both the inner AXGroup and its leaf text are exactly "Inner Touchable";
    // the leaf (smaller, more specific) wins — same philosophy as nodeAtPoint.
    const frame = selectorToFrame(aggregated, { text: "Inner Touchable" });
    expect(frame).toMatchObject({ x: 0.37, y: 0.57 });
  });

  it("selectorToFrame keeps reading order as the tiebreak for equally ranked matches", () => {
    const rows = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Row item", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
        node({ label: "Row item", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } }),
      ],
    });
    expect(selectorToFrame(rows, { text: "Row item" })).toMatchObject({ y: 0.2 });
  });

  it("deriveSelector prefers identifier, then text, then specific role", () => {
    expect(
      deriveSelector(
        node({ identifier: "id1", label: "x", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } })
      )
    ).toEqual({ identifier: "id1" });
    expect(
      deriveSelector(node({ label: "Hi", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toEqual({ text: "Hi" });
    // generic role → no stable selector
    expect(
      deriveSelector(node({ role: "AXGroup", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toBeNull();
    // specific role → role selector
    expect(
      deriveSelector(node({ role: "AXButton", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toEqual({ role: "AXButton" });
  });

  it("deriveSelector refuses invisible-only text (icon-font PUA glyphs, zero-width chars)", () => {
    const frame = { x: 0, y: 0, width: 0.1, height: 0.1 };
    // The QA repro: an expo-router tab-bar icon whose accessibility label is
    // the icon font's Private Use Area glyph (U+E163). Text-wise the node has
    // "nothing stable to match on" — it must fall through, here to null.
    expect(deriveSelector(node({ label: "\uE163", frame }))).toBeNull();
    // Zero-width-only label (ZWSP survives trim(), renders as nothing).
    expect(deriveSelector(node({ label: "\u200B\u200B", frame }))).toBeNull();
    // Invisible label falls through to a visible VALUE...
    expect(deriveSelector(node({ label: "\uE88A", value: "Home", frame }))).toEqual({
      text: "Home",
    });
    // ...or to a specific role when no visible text exists at all.
    expect(deriveSelector(node({ label: "\uE88A", role: "AXButton", frame }))).toEqual({
      role: "AXButton",
    });
    // Visible text that merely CONTAINS an icon glyph stays usable.
    expect(deriveSelector(node({ label: "\uE163 Explore", frame }))).toEqual({
      text: "\uE163 Explore",
    });
  });

  it("deriveSelector derives text from the label alone — never the label+value join", () => {
    // matchNode compares a text selector against label and value individually,
    // so a selector derived from nodeText's join ("Volume 50%") would match no
    // node at all — including the one it was derived from. The label wins over
    // the value: "50%" is the volatile part of a control between runs.
    const volume = node({
      label: "Volume",
      value: "50%",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
    });
    const selector = deriveSelector(volume);
    expect(selector).toEqual({ text: "Volume" });
    // And the derived selector must self-match: the recorder's re-resolve
    // check finds exactly the node it came from.
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [volume],
    });
    expect(findAll(tree, selector!)).toHaveLength(1);
  });

  it("deriveSelector falls back to the value when the node has no label", () => {
    expect(
      deriveSelector(node({ value: "50%", frame: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    ).toEqual({ text: "50%" });
  });

  it("evaluateCondition handles exists/visible/hidden/text", () => {
    const matches = findAll(root, { text: "Login" });
    expect(evaluateCondition("exists", undefined, matches)).toBe(true);
    expect(evaluateCondition("visible", undefined, matches)).toBe(true);
    expect(evaluateCondition("hidden", undefined, matches)).toBe(false);
    expect(evaluateCondition("text", "Login", matches)).toBe(true);
    expect(evaluateCondition("text", "Logout", matches)).toBe(false);
    expect(evaluateCondition("exists", undefined, findAll(root, { text: "Nope" }))).toBe(false);
  });

  it("does not regex-match absent or empty text, even when the pattern can match empty", () => {
    const optionalSaved = "(Saved)?";

    expect(textMatches(undefined, optionalSaved, "matches")).toBe(false);
    expect(textMatches("", optionalSaved, "matches")).toBe(false);
    expect(textMatches("Saved", optionalSaved, "matches")).toBe(true);
  });

  it("regex text conditions retain non-empty own and hoisted text as additive evidence", () => {
    const ownOnly = node({
      label: "Saved",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
    });
    const hoistedOnly = node({
      identifier: "status",
      subtreeText: "Saved successfully",
      frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
    });
    const ownAndHoisted = node({
      label: "Save",
      identifier: "save-button",
      subtreeText: "Saved successfully",
      frame: { x: 0.1, y: 0.3, width: 0.5, height: 0.05 },
    });

    expect(evaluateCondition("text", "^Saved$", [ownOnly], "matches")).toBe(true);
    expect(evaluateCondition("text", "^Saved successfully$", [hoistedOnly], "matches")).toBe(true);
    expect(evaluateCondition("text", "^Save$", [ownAndHoisted], "matches")).toBe(true);
    expect(evaluateCondition("text", "^Saved successfully$", [ownAndHoisted], "matches")).toBe(
      true
    );
  });

  it("only tests an empty-matching selector regex against non-empty label/value fields", () => {
    const absentText = node({
      identifier: "absent-text",
      frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
    });
    const explicitEmptyText = node({
      identifier: "explicit-empty-text",
      label: "",
      value: "",
      frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
    });
    const labelOnly = node({
      identifier: "label-only",
      label: "Label",
      value: "",
      frame: { x: 0.1, y: 0.3, width: 0.5, height: 0.05 },
    });
    const valueOnly = node({
      identifier: "value-only",
      label: "",
      value: "Value",
      frame: { x: 0.1, y: 0.4, width: 0.5, height: 0.05 },
    });
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [absentText, explicitEmptyText, labelOnly, valueOnly],
    });

    // `^` can produce a zero-length match for every string, including "".
    // Empty and absent fields are not text haystacks, while a non-empty field
    // remains eligible even when its sibling field is explicitly empty.
    const matches = findAll(tree, { textMatches: "^" });

    expect(matches).toEqual([labelOnly, valueOnly]);
  });

  it("compiles a selector regex once per tree walk and once per direct node match", () => {
    const nested = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          label: "Order #1",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          children: [
            node({
              label: "Order #2",
              frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
            }),
          ],
        }),
        node({
          label: "Order #3",
          frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
        }),
      ],
    });
    const selector = { textMatches: "^Order #\\d+$" };
    const createRegExp = vi.spyOn(uiTreeMatchInternals, "createRegExp");

    try {
      expect(findAll(nested, selector)).toHaveLength(3);
      expect(createRegExp).toHaveBeenCalledOnce();
      expect(createRegExp).toHaveBeenLastCalledWith(selector.textMatches);

      createRegExp.mockClear();
      expect(matchNode(nested.children[0]!, selector)).toBe(true);
      expect(createRegExp).toHaveBeenCalledOnce();
      expect(createRegExp).toHaveBeenLastCalledWith(selector.textMatches);
    } finally {
      createRegExp.mockRestore();
    }
  });

  it("compiles the search and full-consumption regexes once each per ranking pass", () => {
    const pattern = "Order #\\d+";
    const ranked = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          label: "Order #1 Archive",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        }),
        node({
          label: "Order #1",
          frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
        }),
        node({
          value: "Order #2",
          frame: { x: 0.4, y: 0.6, width: 0.2, height: 0.05 },
        }),
      ],
    });
    const createRegExp = vi.spyOn(uiTreeMatchInternals, "createRegExp");

    try {
      expect(selectorToFrame(ranked, { textMatches: pattern })).toMatchObject({ y: 0.4 });
      expect(createRegExp.mock.calls.map(([source]) => source)).toEqual([
        pattern,
        `^(?:${pattern})$`,
      ]);
    } finally {
      createRegExp.mockRestore();
    }
  });

  it("evaluateCondition `text` prefers the visible match over a zero-area shadow", () => {
    // A stale zero-area node at the top of the screen must not shadow the
    // visible element the check was meant to read — the failure messages
    // (flow assertReason, await-ui-element's timeout note) quote the visible
    // node, and the check must read the same element.
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Total 0", frame: { x: 0.1, y: 0.1, width: 0, height: 0 } }),
        node({ label: "Total 42", frame: { x: 0.1, y: 0.5, width: 0.5, height: 0.05 } }),
      ],
    });
    const matches = findAll(tree, { text: "Total" });
    expect(matches).toHaveLength(2);
    expect(evaluateCondition("text", "42", matches, "contains")).toBe(true);
    expect(evaluateCondition("text", "Total 42", matches, "equals")).toBe(true);
  });

  it("evaluateCondition `text` treats hoisted subtree text as additive to the node's own text", () => {
    // A flow-tree container labelled "Save" wrapping a "Saved successfully"
    // child carries subtreeText "Save Saved successfully". `equals: "Save"` —
    // satisfied by the element's own label on a plain describe tree — must not
    // fail because the hoist stamped a compound string; and the hoisted text
    // still adds passing cases the label alone would miss.
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          label: "Save",
          identifier: "save-button",
          subtreeText: "Save Saved successfully",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        }),
      ],
    });
    const matches = findAll(tree, { identifier: "save-button" });
    expect(evaluateCondition("text", "Save", matches, "equals")).toBe(true);
    expect(evaluateCondition("text", "Save Saved successfully", matches, "equals")).toBe(true);
    expect(evaluateCondition("text", "successfully", matches, "contains")).toBe(true);
    expect(evaluateCondition("text", "Saved", matches, "equals")).toBe(false);
  });

  it("evaluateCondition `text` still reads a value the hoist does not carry", () => {
    // The iOS adapter hoists labels only, so a value-bearing control whose
    // children stamped a subtreeText must not lose its value from the check.
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          label: "Volume",
          value: "50%",
          subtreeText: "Volume Max",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        }),
      ],
    });
    const matches = findAll(tree, { text: "Volume" });
    expect(evaluateCondition("text", "50%", matches, "contains")).toBe(true);
    expect(evaluateCondition("text", "Volume 50%", matches, "equals")).toBe(true);
    expect(evaluateCondition("text", "Max", matches, "contains")).toBe(true);
  });

  it("evaluateCondition `text` falls back to all matches when none is visible", () => {
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [node({ label: "Total 42", frame: { x: 0.1, y: 0.1, width: 0, height: 0 } })],
    });
    const matches = findAll(tree, { text: "Total" });
    expect(evaluateCondition("text", "42", matches, "contains")).toBe(true);
  });

  it("treeFingerprint is stable for an unchanged tree and changes when a frame moves", () => {
    const a = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } })],
    });
    const same = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 } })],
    });
    const moved = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      // same row scrolled up — a fling still in flight
      children: [node({ label: "Row", frame: { x: 0.1, y: 0.05, width: 0.8, height: 0.1 } })],
    });
    expect(treeFingerprint(a)).toBe(treeFingerprint(same));
    expect(treeFingerprint(a)).not.toBe(treeFingerprint(moved));
  });

  it("treeFingerprint ignores sub-1e-3 jitter", () => {
    const a = node({ frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    const jittered = node({ frame: { x: 0.10001, y: 0.2, width: 0.3, height: 0.4 } });
    expect(treeFingerprint(a)).toBe(treeFingerprint(jittered));
  });

  it("treeFingerprint with an include filter ignores excluded nodes but still walks their children", () => {
    const tree = (tick: string) =>
      node({
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          node({ label: tick, frame: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 } }),
          node({ label: "Row", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
        ],
      });
    const belowFold = (n: DescribeNode) => n.frame.y >= 0.2;
    // The ticker (excluded) changed; the filtered fingerprint must not.
    expect(treeFingerprint(tree("0:01"), belowFold)).toBe(treeFingerprint(tree("0:02"), belowFold));
    expect(treeFingerprint(tree("0:01"))).not.toBe(treeFingerprint(tree("0:02")));
  });
});

describe("identifier matching", () => {
  it("matches exactly, case-insensitively — never as a substring", () => {
    expect(identifierMatches("login-btn", "login-btn")).toBe(true);
    expect(identifierMatches("Login-Btn", "login-btn")).toBe(true);
    // A partial id must not match: an identifier names one element, and a
    // substring lets a short needle capture an unrelated id.
    expect(identifierMatches("login-btn", "login")).toBe(false);
    expect(identifierMatches("autosave-banner", "Save")).toBe(false);
    expect(identifierMatches(undefined, "login-btn")).toBe(false);
  });

  it("matches the unqualified name of an Android resource-id", () => {
    expect(identifierMatches("com.example.app:id/submit", "submit")).toBe(true);
    expect(identifierMatches("com.example.app:id/submit", "Submit")).toBe(true);
    expect(identifierMatches("com.example.app:id/submit", "com.example.app:id/submit")).toBe(true);
    // Only the whole unqualified name — not a substring of it, and not a
    // partial package path.
    expect(identifierMatches("com.example.app:id/submit", "sub")).toBe(false);
    expect(identifierMatches("com.example.app:id/submit", "app:id/submit")).toBe(false);
  });

  it("findAll with an identifier selector is exact — a loose 'save' cannot hijack 'autosave-banner'", () => {
    const tree = node({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ identifier: "autosave-banner", frame: { x: 0, y: 0.1, width: 1, height: 0.1 } }),
        node({ label: "Save", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } }),
      ],
    });
    expect(findAll(tree, { identifier: "save" })).toHaveLength(0);
    expect(findAll(tree, { identifier: "autosave-banner" })).toHaveLength(1);
  });
});

describe("within (descendant) scoping", () => {
  // Two cards each containing a "Delete" button, plus an unscoped one at the
  // top level — the classic "same label everywhere" screen `within` exists for.
  const cards = node({
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      node({
        role: "AXButton",
        label: "Delete",
        frame: { x: 0.1, y: 0.05, width: 0.2, height: 0.05 },
      }),
      node({
        role: "AXGroup",
        identifier: "profile-card",
        frame: { x: 0, y: 0.2, width: 1, height: 0.3 },
        children: [
          node({
            role: "AXButton",
            label: "Delete",
            frame: { x: 0.1, y: 0.4, width: 0.2, height: 0.05 },
          }),
        ],
      }),
      node({
        role: "AXGroup",
        identifier: "billing-card",
        frame: { x: 0, y: 0.6, width: 1, height: 0.3 },
        children: [
          node({
            role: "AXButton",
            label: "Delete",
            frame: { x: 0.1, y: 0.8, width: 0.2, height: 0.05 },
          }),
        ],
      }),
    ],
  });

  it("findAll keeps only matches inside the container", () => {
    const matches = findAll(cards, { text: "Delete", within: { identifier: "billing-card" } });
    expect(matches).toHaveLength(1);
    expect(matches[0].frame.y).toBe(0.8);
  });

  it("selectorToFrame resolves the scoped element, not the first in reading order", () => {
    const frame = selectorToFrame(cards, {
      text: "Delete",
      within: { identifier: "profile-card" },
    });
    expect(frame).toMatchObject({ y: 0.4 });
  });

  it("an unscoped selector still sees every match", () => {
    expect(findAll(cards, { text: "Delete" })).toHaveLength(3);
  });

  it("a missing container yields no matches even though the target text exists", () => {
    expect(findAll(cards, { text: "Delete", within: { identifier: "no-such-card" } })).toEqual([]);
  });

  it("the container must be a DISTINCT element — a node can never scope itself", () => {
    // profile-card is the only node matching the scope, and it is the node
    // being selected; `within` demands a distinct container, so nothing matches.
    expect(
      findAll(cards, { identifier: "profile-card", within: { identifier: "profile-card" } })
    ).toEqual([]);
  });

  it("scoping is geometric, so it works on the flat tree shape the flow adapters emit", () => {
    // Production flow trees flatten every platform hierarchy into leaves under
    // one synthetic root (flow-tree-flatten) — containment must come from
    // frames, not ancestry.
    const flat = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ identifier: "billing-card", frame: { x: 0, y: 0.6, width: 1, height: 0.3 } }),
        node({ label: "Delete", frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 } }),
        node({ label: "Delete", frame: { x: 0.1, y: 0.8, width: 0.2, height: 0.05 } }),
      ],
    });
    const matches = findAll(flat, { text: "Delete", within: { identifier: "billing-card" } });
    expect(matches).toHaveLength(1);
    expect(matches[0].frame.y).toBe(0.8);
  });

  it("an element whose frame overflows the container is not within it, ancestry or not", () => {
    // A tree child rendered outside its parent's frame (overlay, badge) is
    // visually NOT inside the container — geometry, not ancestry, decides.
    const overlay = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "card",
          frame: { x: 0, y: 0.2, width: 0.5, height: 0.2 },
          children: [node({ label: "Badge", frame: { x: 0.7, y: 0.7, width: 0.1, height: 0.05 } })],
        }),
      ],
    });
    expect(findAll(overlay, { text: "Badge", within: { identifier: "card" } })).toEqual([]);
  });

  it("the synthetic root cannot satisfy a scope", () => {
    // The root wraps every screen — letting it match would make a broad
    // role-based scope vacuous (same doctrine as target matching).
    expect(findAll(cards, { text: "Delete", within: { role: "AXWindow" } })).toEqual([]);
  });

  it("chained scopes require nested containers, in order", () => {
    const tree = node({
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "settings",
          frame: { x: 0, y: 0, width: 1, height: 0.5 },
          children: [
            node({
              identifier: "cards",
              frame: { x: 0, y: 0.1, width: 1, height: 0.3 },
              children: [
                node({ label: "Delete", frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 } }),
              ],
            }),
          ],
        }),
        // A "cards" container NOT inside "settings" — its Delete must not match.
        node({
          identifier: "cards",
          frame: { x: 0, y: 0.6, width: 1, height: 0.3 },
          children: [
            node({ label: "Delete", frame: { x: 0.1, y: 0.7, width: 0.2, height: 0.05 } }),
          ],
        }),
      ],
    });
    const matches = findAll(tree, {
      text: "Delete",
      within: { identifier: "cards", within: { identifier: "settings" } },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].frame.y).toBe(0.2);
    // Reversed nesting (settings inside cards) exists nowhere in this tree.
    expect(
      findAll(tree, {
        text: "Delete",
        within: { identifier: "settings", within: { identifier: "cards" } },
      })
    ).toEqual([]);
  });

  it("one container cannot satisfy two chain levels", () => {
    const doubled = (leafLabel: string, depth: number): DescribeNode => {
      let child = node({ label: leafLabel, frame: { x: 0.1, y: 0.4, width: 0.2, height: 0.05 } });
      for (let i = 0; i < depth; i++) {
        child = node({
          label: "Row",
          frame: { x: 0, y: 0, width: 1, height: 1 },
          children: [child],
        });
      }
      return node({
        role: "AXWindow",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [child],
      });
    };
    const twoRows = { text: "Leaf", within: { text: "Row", within: { text: "Row" } } };
    // Two distinct "Row" containers satisfy "Row inside Row"…
    expect(findAll(doubled("Leaf", 2), twoRows)).toHaveLength(1);
    // …a single one cannot double-count for both levels.
    expect(findAll(doubled("Leaf", 1), twoRows)).toEqual([]);
  });

  it("a scope can use the regex text matcher", () => {
    const matches = findAll(cards, {
      text: "Delete",
      within: { textMatches: "^$" }, // matches no container label
    });
    expect(matches).toEqual([]);
    const scoped = findAll(cards, {
      role: "AXButton",
      within: { identifier: "profile-card" },
    });
    expect(scoped).toHaveLength(1);
  });

  // ── Containment tolerance (WITHIN_EPS) ────────────────────────────────────
  // The container's frame is x:0.2..0.6, y:0.2..0.6; each element below sits
  // fully inside on three edges and overhangs the LEFT edge by a fixed amount,
  // isolating the tolerance band so the assertions pin WITHIN_EPS from both
  // sides — zeroing it drops the sub-pixel case, inflating it swallows real
  // overflow.
  const tolerance = (leftOverhang: number, label: string): DescribeNode =>
    node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ identifier: "box", frame: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }),
        node({ label, frame: { x: 0.2 - leftOverhang, y: 0.3, width: 0.1, height: 0.1 } }),
      ],
    });

  it("admits an element overhanging its container by less than the tolerance", () => {
    // 0.003 of overhang is a border/shadow/rounding hair (< WITHIN_EPS): the
    // element visually belongs to the container and must still resolve. This is
    // the exact band the tolerance exists for — with WITHIN_EPS at 0 it drops.
    const tree = tolerance(0.003, "Edge");
    expect(findAll(tree, { text: "Edge", within: { identifier: "box" } })).toHaveLength(1);
  });

  it("rejects an element overhanging its container beyond the tolerance", () => {
    // 0.03 of overhang is real overflow, not sub-pixel slack: the element sits
    // outside the container and must not resolve — pinning the tolerance's upper
    // edge so it can't be inflated into swallowing a true overflow.
    const tree = tolerance(0.03, "Over");
    expect(findAll(tree, { text: "Over", within: { identifier: "box" } })).toEqual([]);
  });

  it("treats an equal frame as within — coincident distinct nodes each scope the other", () => {
    // Two DISTINCT nodes sharing the exact same frame are each inside the other:
    // containment is inclusive (frames may coincide), and the only guard is the
    // distinct-node rule (`c !== node`). This locks that observable semantic —
    // the real case is a testID wrapper laid exactly over the control it wraps,
    // where scoping to the wrapper must still resolve the control.
    const tree = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "wrapper",
          role: "AXGroup",
          frame: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
        }),
        node({
          identifier: "control",
          label: "Submit",
          frame: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
        }),
      ],
    });
    // The control sits exactly inside its equal-framed wrapper.
    expect(findAll(tree, { text: "Submit", within: { identifier: "wrapper" } })).toHaveLength(1);
    // ...and two equal-framed nodes both matching one selector each count as
    // within the other (mutual), so both survive the scope.
    const twins = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "a",
          role: "AXButton",
          frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        }),
        node({
          identifier: "b",
          role: "AXButton",
          frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        }),
      ],
    });
    expect(findAll(twins, { role: "AXButton", within: { role: "AXButton" } })).toHaveLength(2);
  });

  // ── Grid-indexed containment (large container sets) ───────────────────────
  it("indexed containment agrees with a naive scan on a large random tree", () => {
    // Above CONTAINMENT_GRID_MIN containers, findAll indexes them in a grid
    // instead of scanning; the indexed result must equal a brute-force scan.
    // Deterministic LCG keeps the fuzz case reproducible (no Math.random flake).
    let seed = 123456789;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const containers: DescribeNode[] = [];
    for (let i = 0; i < 80; i++) {
      containers.push(
        node({
          role: "AXGroup",
          identifier: `c${i}`,
          frame: {
            x: rand() * 0.8,
            y: rand() * 0.8,
            width: 0.1 + rand() * 0.15,
            height: 0.1 + rand() * 0.15,
          },
        })
      );
    }
    const leaves: DescribeNode[] = [];
    for (let i = 0; i < 150; i++) {
      leaves.push(
        node({
          identifier: `l${i}`,
          label: "leaf",
          frame: {
            x: rand() * 0.95,
            y: rand() * 0.95,
            width: 0.02 + rand() * 0.03,
            height: 0.02 + rand() * 0.03,
          },
        })
      );
    }
    const tree = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [...containers, ...leaves],
    });

    const scoped = findAll(tree, { text: "leaf", within: { role: "AXGroup" } });
    const eps = 0.005;
    const within = (inner: DescribeNode["frame"], outer: DescribeNode["frame"]): boolean =>
      inner.x >= outer.x - eps &&
      inner.y >= outer.y - eps &&
      inner.x + inner.width <= outer.x + outer.width + eps &&
      inner.y + inner.height <= outer.y + outer.height + eps;
    const expected = leaves.filter((l) => containers.some((c) => within(l.frame, c.frame)));

    const ids = (ns: DescribeNode[]): string[] => ns.map((n) => n.identifier!).sort();
    expect(scoped.length).toBeGreaterThan(0); // the fuzz actually exercises containment
    expect(ids(scoped)).toEqual(ids(expected));
  });

  it("indexed containment honors the tolerance for an edge-overhanging leaf", () => {
    // Force the grid path (> CONTAINMENT_GRID_MIN containers) and place the one
    // matching leaf overhanging a cell's left edge by < WITHIN_EPS — the grid's
    // eps-padded cell coverage must still find its container.
    const children: DescribeNode[] = [];
    for (let i = 0; i < 40; i++) {
      const col = i % 8;
      const row = Math.floor(i / 8);
      children.push(
        node({
          role: "AXGroup",
          identifier: `cell-${i}`,
          frame: { x: col * 0.12, y: row * 0.12, width: 0.1, height: 0.1 },
        })
      );
    }
    // Inside cell-0 (x 0..0.1, y 0..0.1), overhanging its left edge by 0.003.
    children.push(
      node({ label: "Pick", frame: { x: -0.003, y: 0.02, width: 0.05, height: 0.05 } })
    );
    const tree = node({ role: "Screen", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
    const scoped = findAll(tree, { text: "Pick", within: { role: "AXGroup" } });
    expect(scoped).toHaveLength(1);
  });
});

describe("after / next (sibling) scoping", () => {
  // A settings list: three rows, each a label plus a switch to its right. The
  // switches are taller than their labels and therefore sit a hair HIGHER — the
  // shape a raw top-y reading order gets wrong, and the reason "after" compares
  // row bands rather than top edges.
  const rowY = { airplane: 0.2, wifi: 0.3, bluetooth: 0.4 };
  const settings = node({
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: Object.entries(rowY).flatMap(([name, y]) => [
      node({
        role: "AXStaticText",
        label: name === "wifi" ? "Wi-Fi" : name,
        frame: { x: 0.05, y, width: 0.3, height: 0.04 },
      }),
      node({
        role: "AXSwitch",
        identifier: `sw-${name}`,
        frame: { x: 0.8, y: y - 0.005, width: 0.15, height: 0.05 },
      }),
    ]),
  });
  const ids = (ns: DescribeNode[]): string[] => ns.map((n) => n.identifier!).sort();

  it("after keeps every match following the anchor, in reading order", () => {
    // The Wi-Fi row's own switch (same band, to the right) and everything below
    // it — but not the Airplane switch above.
    expect(ids(findAll(settings, { role: "AXSwitch", after: { text: "Wi-Fi" } }))).toEqual([
      "sw-bluetooth",
      "sw-wifi",
    ]);
  });

  it("next keeps only the NEAREST follower — the control belonging to that row", () => {
    expect(ids(findAll(settings, { role: "AXSwitch", next: { text: "Wi-Fi" } }))).toEqual([
      "sw-wifi",
    ]);
    expect(ids(findAll(settings, { role: "AXSwitch", next: { text: "airplane" } }))).toEqual([
      "sw-airplane",
    ]);
  });

  it("next unions over anchors — one nearest pick each, like CSS `A + B`", () => {
    expect(ids(findAll(settings, { role: "AXSwitch", next: { role: "AXStaticText" } }))).toEqual([
      "sw-airplane",
      "sw-bluetooth",
      "sw-wifi",
    ]);
  });

  it("a same-band element to the LEFT of the anchor does not follow it", () => {
    // The label is left of its own row's switch, so it never follows it — the
    // asymmetry that makes `after` an ordering rather than a proximity test.
    expect(findAll(settings, { text: "Wi-Fi", after: { identifier: "sw-wifi" } })).toEqual([]);
  });

  it("the anchor must be a DISTINCT element — nothing follows itself", () => {
    // Every switch but the topmost follows another switch; the topmost follows
    // none, and no switch is admitted by matching itself.
    expect(ids(findAll(settings, { role: "AXSwitch", after: { role: "AXSwitch" } }))).toEqual([
      "sw-bluetooth",
      "sw-wifi",
    ]);
  });

  it("a missing anchor yields no matches even though the target exists", () => {
    expect(findAll(settings, { role: "AXSwitch", after: { text: "no-such-row" } })).toEqual([]);
    expect(findAll(settings, { role: "AXSwitch", next: { text: "no-such-row" } })).toEqual([]);
  });

  it("the synthetic root can never be an anchor", () => {
    // Were the root admitted, it would sit above/left of nothing and follow
    // nothing — but a root-matching anchor selector must find no anchor at all.
    expect(findAll(settings, { role: "AXSwitch", after: { role: "AXWindow" } })).toEqual([]);
  });

  it("containment is not following — an element inside the anchor does not follow it", () => {
    const card = node({
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "card",
          role: "AXGroup",
          frame: { x: 0, y: 0.1, width: 1, height: 0.3 },
        }),
        node({
          identifier: "inner",
          label: "Inner",
          frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
        }),
      ],
    });
    expect(findAll(card, { text: "Inner", after: { identifier: "card" } })).toEqual([]);
    // ...while the same element IS inside it.
    expect(ids(findAll(card, { text: "Inner", within: { identifier: "card" } }))).toEqual([
      "inner",
    ]);
  });

  it("admits a follower overhanging the anchor's bottom edge by less than the tolerance", () => {
    // Anchor bottom 0.30; the follower starts 0.0045 above it — inside
    // WITHIN_EPS, so it still reads as the next row rather than the same one.
    const tree = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Header", frame: { x: 0.1, y: 0.26, width: 0.3, height: 0.04 } }),
        node({
          identifier: "near",
          role: "AXButton",
          frame: { x: 0.1, y: 0.2955, width: 0.3, height: 0.04 },
        }),
      ],
    });
    expect(ids(findAll(tree, { role: "AXButton", after: { text: "Header" } }))).toEqual(["near"]);
  });

  it("rejects a follower overhanging beyond the tolerance when it is also not to the right", () => {
    const tree = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Header", frame: { x: 0.1, y: 0.26, width: 0.3, height: 0.04 } }),
        // 0.006 above the anchor's bottom (past WITHIN_EPS) and horizontally
        // overlapping it, so neither the below nor the right rule holds.
        node({
          identifier: "far",
          role: "AXButton",
          frame: { x: 0.1, y: 0.294, width: 0.3, height: 0.04 },
        }),
      ],
    });
    expect(findAll(tree, { role: "AXButton", after: { text: "Header" } })).toEqual([]);
  });

  it("a universal (field-less) selector resolves to the anchor's immediate neighbour", () => {
    // The `any: true` spelling in flow YAML: no own constraint, so the scope
    // alone decides. `next` then names the very next element on screen.
    expect(ids(findAll(settings, { next: { text: "Wi-Fi" } }))).toEqual(["sw-wifi"]);
  });

  it("scopes compose — `within` narrows the pool `next` then picks from", () => {
    // Two identical rows in two cards: scoping to one card must make `next`
    // pick that card's control, not the first one on screen.
    const twoCards = node({
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          identifier: "card-a",
          role: "AXGroup",
          frame: { x: 0, y: 0.1, width: 1, height: 0.2 },
        }),
        node({ label: "Name", frame: { x: 0.05, y: 0.15, width: 0.3, height: 0.04 } }),
        node({
          identifier: "edit-a",
          role: "AXButton",
          frame: { x: 0.8, y: 0.15, width: 0.15, height: 0.04 },
        }),
        node({
          identifier: "card-b",
          role: "AXGroup",
          frame: { x: 0, y: 0.5, width: 1, height: 0.2 },
        }),
        node({ label: "Name", frame: { x: 0.05, y: 0.55, width: 0.3, height: 0.04 } }),
        node({
          identifier: "edit-b",
          role: "AXButton",
          frame: { x: 0.8, y: 0.55, width: 0.15, height: 0.04 },
        }),
      ],
    });
    // Scoping the ANCHOR leaves one anchor, so one pick.
    expect(
      ids(
        findAll(twoCards, {
          role: "AXButton",
          next: { text: "Name", within: { identifier: "card-b" } },
        })
      )
    ).toEqual(["edit-b"]);
    // Scoping the TARGET narrows the pool `next` picks from instead: both
    // rows' labels are still anchors, but the only button they can reach is
    // card-b's.
    expect(
      ids(
        findAll(twoCards, {
          role: "AXButton",
          next: { text: "Name" },
          within: { identifier: "card-b" },
        })
      )
    ).toEqual(["edit-b"]);
    // Unscoped, each anchor contributes its own nearest match — CSS `A + B` is
    // likewise the union over every A.
    expect(ids(findAll(twoCards, { role: "AXButton", next: { text: "Name" } }))).toEqual([
      "edit-a",
      "edit-b",
    ]);
  });

  it("a same-row follower beats one on the row below, whatever their top edges say", () => {
    // The row's own control sits slightly HIGHER than the label; the next row's
    // control sits lower but starts further left. Reading order must take the
    // row-mate, not whichever frame happens to start highest.
    const rows = node({
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({ label: "Row", frame: { x: 0.05, y: 0.3, width: 0.3, height: 0.04 } }),
        node({
          identifier: "mate",
          role: "AXButton",
          frame: { x: 0.8, y: 0.29, width: 0.15, height: 0.06 },
        }),
        node({
          identifier: "below",
          role: "AXButton",
          frame: { x: 0.05, y: 0.4, width: 0.15, height: 0.04 },
        }),
      ],
    });
    expect(ids(findAll(rows, { role: "AXButton", next: { text: "Row" } }))).toEqual(["mate"]);
  });

  it("selectorToFrame resolves a sibling-scoped target to the right element", () => {
    expect(selectorToFrame(settings, { role: "AXSwitch", next: { text: "Wi-Fi" } })).toMatchObject({
      y: rowY.wifi - 0.005,
    });
  });

  it("evaluateCondition sees a sibling scope like any other match set", () => {
    const scoped = findAll(settings, { role: "AXSwitch", next: { text: "bluetooth" } });
    expect(evaluateCondition("visible", undefined, scoped)).toBe(true);
    expect(evaluateCondition("hidden", undefined, scoped)).toBe(false);
    // Nothing follows the last row's switch, so a scope anchored on it is empty
    // — `hidden` holds, `visible` does not.
    const empty = findAll(settings, { role: "AXSwitch", after: { identifier: "sw-bluetooth" } });
    expect(evaluateCondition("hidden", undefined, empty)).toBe(true);
    expect(evaluateCondition("visible", undefined, empty)).toBe(false);
  });

  // ── Indexed sibling resolution (large node sets) ──────────────────────────
  it("indexed after/next agree with a naive scan on a large random tree", () => {
    // Both relations prune with a y-sorted index plus a prefix-max reach bound;
    // the pruned result must equal the brute-force definition on every input.
    // Deterministic LCG keeps the fuzz case reproducible (no Math.random flake).
    let seed = 987654321;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const anchors: DescribeNode[] = [];
    const leaves: DescribeNode[] = [];
    for (let i = 0; i < 60; i++) {
      anchors.push(
        node({
          role: "AXAnchor",
          identifier: `a${i}`,
          frame: {
            x: rand() * 0.9,
            y: rand() * 0.9,
            width: 0.02 + rand() * 0.2,
            height: 0.02 + rand() * 0.2,
          },
        })
      );
    }
    for (let i = 0; i < 120; i++) {
      leaves.push(
        node({
          identifier: `l${i}`,
          label: "leaf",
          frame: {
            x: rand() * 0.9,
            y: rand() * 0.9,
            width: 0.02 + rand() * 0.1,
            height: 0.02 + rand() * 0.1,
          },
        })
      );
    }
    const tree = node({
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [...anchors, ...leaves],
    });

    const eps = 0.005;
    type F = DescribeNode["frame"];
    const above = (a: F, b: F): boolean => a.y + a.height <= b.y + eps;
    const isAfter = (n: F, a: F): boolean => {
      if (above(a, n)) return true;
      if (above(n, a)) return false;
      return a.x + a.width <= n.x + eps;
    };
    const expectedAfter = leaves.filter((l) => anchors.some((a) => isAfter(l.frame, a.frame)));
    expect(expectedAfter.length).toBeGreaterThan(0); // the fuzz exercises the relation
    expect(ids(findAll(tree, { text: "leaf", after: { role: "AXAnchor" } }))).toEqual(
      ids(expectedAfter)
    );

    // `next` = per anchor: the leftmost follower sharing its row band, else the
    // topmost of those strictly below it.
    const best = (group: DescribeNode[], major: "x" | "y"): DescribeNode =>
      group.reduce((m, l) => {
        const minor = major === "x" ? "y" : "x";
        const win =
          l.frame[major] < m.frame[major] ||
          (l.frame[major] === m.frame[major] && l.frame[minor] < m.frame[minor]);
        return win ? l : m;
      });
    const picked = new Set<DescribeNode>();
    for (const a of anchors) {
      const followers = leaves.filter((l) => l !== a && isAfter(l.frame, a.frame));
      const band = followers.filter((l) => !above(a.frame, l.frame));
      const below = followers.filter((l) => above(a.frame, l.frame));
      if (band.length > 0) picked.add(best(band, "x"));
      else if (below.length > 0) picked.add(best(below, "y"));
    }
    expect(picked.size).toBeGreaterThan(0);
    expect(ids(findAll(tree, { text: "leaf", next: { role: "AXAnchor" } }))).toEqual(
      ids([...picked])
    );
  });
});
