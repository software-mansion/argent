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
