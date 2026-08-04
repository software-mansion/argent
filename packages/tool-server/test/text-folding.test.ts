import { describe, expect, it } from "vitest";
import {
  compatibilityVariantOf,
  confusableTextNote,
  equalsCI,
  evaluateCondition,
  findAll,
  foldText,
  identifierMatches,
  includesCI,
} from "../src/utils/ui-tree-match";
import type { DescribeNode } from "../src/tools/describe/contract";

// R10. Two strings that render identically compared unequal, because the
// comparison was a plain `toLowerCase()`. The observed failure:
//
//   element matched but its text was "Amount, PLN 42.00"
//   (wanted to equal "Amount, PLN 42.00")   success: false, elapsed: 15001
//
// — a non-breaking space in the currency label. Two sessions paid a full 15s
// timeout per attempt for it, and in CI it is an unexplainable red build.

const NBSP = " ";
const NARROW_NBSP = " ";
const ZWSP = "​";
const ZWJ = "‍";
const BOM = "﻿";
const SOFT_HYPHEN = "­";
const VARIATION_SELECTOR_16 = "️";
const IDEOGRAPHIC_SPACE = "　";

describe("foldText", () => {
  it("reduces every space-like codepoint to a plain space", () => {
    expect(foldText(`a${NBSP}b`)).toBe("a b");
    expect(foldText(`a${NARROW_NBSP}b`)).toBe("a b");
    expect(foldText(`a${IDEOGRAPHIC_SPACE}b`)).toBe("a b");
  });

  it("strips invisible formatting", () => {
    expect(foldText(`a${ZWSP}b`)).toBe("ab");
    expect(foldText(`${BOM}ab`)).toBe("ab");
    expect(foldText(`so${SOFT_HYPHEN}ft`)).toBe("soft");
  });

  it("keeps the joiners that BUILD a glyph", () => {
    // Invisible alone, load-bearing in sequence. The transgender flag is
    // U+1F3F3 VS16 ZWJ U+26A7 VS16 and renders as ONE glyph; folding the
    // joiners away equated it with the two separate glyphs, so a check passed
    // against a visibly different display name — and a broken sequence, a real
    // rendering regression, became invisible to every check.
    const FLAG = "\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F";
    const SPLIT = "\u{1F3F3}\u26A7";
    expect(foldText(FLAG)).not.toBe(foldText(SPLIT));
    expect(foldText(`a${ZWJ}b`)).not.toBe("ab");
    expect(foldText(`ok${VARIATION_SELECTOR_16}`)).not.toBe("ok");
  });

  it("applies NFC, collapses whitespace runs, trims and lowercases", () => {
    // Canonical: a decomposed "é" (e + U+0301) folds onto the precomposed one,
    // because they render identically.
    expect(foldText("Cafe\u0301")).toBe(foldText("Café"));
    expect(foldText("  Save   Changes \n")).toBe("save changes");
  });

  it("keeps COMPATIBILITY variants distinct — the eye can see those", () => {
    // NFKC would fold every one of these onto plain ASCII, which made a
    // blackletter display name compare equal to the account it imitates.
    expect(foldText("𝕴𝖓𝖋𝖊𝖗𝖓𝖆𝖙𝖗𝖎𝖝")).not.toBe(foldText("Infernatrix"));
    expect(foldText("Ａ")).not.toBe(foldText("A")); // fullwidth
    expect(foldText("ﬁle")).not.toBe(foldText("file")); // ligature
    expect(foldText("x²")).not.toBe(foldText("x2")); // superscript
  });

  it("leaves visibly different text different", () => {
    expect(foldText("Save")).not.toBe(foldText("Saved"));
    expect(foldText("PLN 42.00")).not.toBe(foldText("PLN 42.0"));
  });
});

describe("literal comparisons fold both sides", () => {
  it("equates the reported currency label with the typed one", () => {
    const onScreen = `Amount, PLN${NBSP}42.00`;
    const authored = "Amount, PLN 42.00";
    expect(onScreen).not.toBe(authored); // the strings really do differ
    expect(equalsCI(onScreen, authored)).toBe(true);
    expect(includesCI(onScreen, "PLN 42.00")).toBe(true);
  });

  it("still refuses a genuine mismatch", () => {
    expect(equalsCI(`PLN${NBSP}42.00`, "PLN 43.00")).toBe(false);
    expect(includesCI("Save", "Saved")).toBe(false);
  });

  it("folds identifiers, including the unqualified Android resource-id form", () => {
    expect(identifierMatches(`submit${ZWSP}`, "submit")).toBe(true);
    expect(identifierMatches("com.example.app:id/submit", `sub${ZWSP}mit`)).toBe(true);
    // Substring capture is still refused — folding must not loosen this.
    expect(identifierMatches("autosave-banner", "save")).toBe(false);
  });
});

describe("bidi wrappers", () => {
  // An app that renders user-supplied names wraps every one of them. A census
  // of four Bluesky web screens found 367 U+202A/U+202C pairs and not one
  // NBSP — so this, not the currency space, is the common real instance.
  const LRE = "‪"; // U+202A LEFT-TO-RIGHT EMBEDDING
  const PDF = "‬"; // U+202C POP DIRECTIONAL FORMATTING
  const LRI = "⁦"; // U+2066 LEFT-TO-RIGHT ISOLATE
  const PDI = "⁩"; // U+2069 POP DIRECTIONAL ISOLATE

  it("equates a bidi-wrapped handle with the plain one", () => {
    expect(equalsCI(`${LRE}@bsky.app${PDF}`, "@bsky.app")).toBe(true);
    expect(equalsCI(`${LRI}@bsky.app${PDI}`, "@bsky.app")).toBe(true);
    expect(includesCI(`${LRE}Jane Doe${PDF} posted`, "Jane Doe")).toBe(true);
  });

  it("does not swallow the narrow no-break space next to that range", () => {
    // U+202F sits one codepoint past the embeddings; it is a SPACE, not a
    // formatting control, and must fold to " " rather than vanish.
    expect(foldText(`a${NARROW_NBSP}b`)).toBe("a b");
  });
});

describe("compatibilityVariantOf", () => {
  // NFC keeps these apart on purpose, so a miss needs an explanation rather
  // than a fold. An author types `...`; the app renders one U+2026.
  it("recognises a typed ellipsis against a rendered one", () => {
    expect(compatibilityVariantOf("Add more languages…", "Add more languages...")).toBe(true);
    expect(compatibilityVariantOf("ﬁle", "file")).toBe(true);
    expect(compatibilityVariantOf("Ａ", "A")).toBe(true);
    expect(compatibilityVariantOf("𝕴𝖓𝖋𝖊𝖗𝖓𝖆𝖙𝖗𝖎𝖝", "Infernatrix")).toBe(true);
  });

  it("says nothing when the strings already fold together, or genuinely differ", () => {
    expect(compatibilityVariantOf(`PLN${NBSP}42`, "PLN 42")).toBe(false);
    expect(compatibilityVariantOf("Save", "Saved")).toBe(false);
  });
});

describe("confusableTextNote", () => {
  // The note is the safety net for an invisible character the fold's explicit
  // classes do NOT list — anything the fold handles compares equal, so the
  // check passes and there is no message to annotate.
  const UNHANDLED_FORMAT = "\u{110BD}"; // KAITHI NUMBER SIGN, category Cf

  it("names the differing codepoints when the strings only look equal", () => {
    const note = confusableTextNote(`PLN 42${UNHANDLED_FORMAT}`, "PLN 42")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+110BD");
  });

  it("says nothing when the strings are equal, or visibly different", () => {
    expect(confusableTextNote("PLN 42", "PLN 42")).toBeUndefined();
    expect(confusableTextNote("PLN 42", "PLN 43")).toBeUndefined();
  });

  it("does not call a CASE difference invisible", () => {
    // The literal comparators fold case, so a case-only pair passes and never
    // reaches the note. A regex comparison is case-sensitive by design — and
    // "Home" vs "HOME" differ in characters the eye reads perfectly well, so
    // claiming otherwise would be a false explanation of the failure.
    expect(confusableTextNote("Home", "HOME")).toBeUndefined();
  });

  it("does not call an NFKC compatibility difference invisible", () => {
    // "ﬁ" vs "fi" is a visible difference in glyph, whatever NFKC says.
    expect(confusableTextNote("ﬁle", "file")).toBeUndefined();
  });

  it("says nothing for a difference the fold already absorbs", () => {
    // An NBSP folds to a plain space, so the comparators compare EQUAL and the
    // check passes without ever reaching the note. Called directly it must
    // still stay quiet — NBSP is space-like (Zs), not a Cf format character, so
    // it is not the "invisible difference" this note explains.
    expect(equalsCI(`PLN${NBSP}42`, "PLN 42")).toBe(true);
    expect(confusableTextNote(`PLN${NBSP}42`, "PLN 42")).toBeUndefined();
  });
});

describe("a needle that folds away to nothing", () => {
  // Folding turned a non-empty selector value into an empty one, and an empty
  // needle is not a weak constraint — it is NO constraint. `{ role: " " }`
  // matched every element on a real Bluesky screen and the check could never
  // fail: the same unfalsifiable-gate defect the `hidden` evidence rule exists
  // to prevent, arriving through a selector field instead.
  const BLANK_NEEDLES = [" ", " ", "​", "‪‬", "\t\n "];

  it.each(BLANK_NEEDLES)("includesCI(%j) matches nothing", (needle) => {
    expect(includesCI("Button", needle)).toBe(false);
    expect(includesCI("anything at all", needle)).toBe(false);
  });

  it.each(BLANK_NEEDLES)("identifierMatches(%j) matches nothing", (needle) => {
    expect(identifierMatches("save-button", needle)).toBe(false);
    expect(identifierMatches("com.example.app:id/save-button", needle)).toBe(false);
  });

  it.each(BLANK_NEEDLES)("equalsCI(_, %j) equals nothing — not even a textless node", (needle) => {
    // Same guard, extended to the exact comparator: an expected that folds
    // away is NO constraint, so a `text`/`equals` check against a textless
    // element (whose folded text is "") must NOT pass. Without the guard
    // `equalsCI("", " ") === true` — a silently-passing assertion.
    expect(equalsCI("", needle)).toBe(false);
    expect(equalsCI(undefined, needle)).toBe(false);
    expect(equalsCI("Button", needle)).toBe(false);
  });

  it("still matches a real value, so the guard is not over-broad", () => {
    expect(includesCI("Button", "butt")).toBe(true);
    expect(identifierMatches("com.example.app:id/save-button", "save-button")).toBe(true);
    expect(equalsCI("Save", "save")).toBe(true);
    // A bidi-wrapped label still equals its plain form — the guard rejects only
    // an expected that folds to EMPTY, never a real one.
    expect(equalsCI("‪@bsky.app‬", "@bsky.app")).toBe(true);
  });
});

describe("end-to-end: a plain selector matches a bidi-wrapped label through findAll", () => {
  // The comparators are exercised above in isolation; this pins the user-facing
  // invariant that the fold actually reaches the MATCH pipeline
  // (findAll -> evaluateCondition), so a plain authored selector resolves — and
  // a `text`/`equals` step goes green against — a label wrapped the way Bluesky
  // wraps every display name: LRE ... PDF (U+202A ... U+202C), the exact form
  // captured off a real iPhone/Pixel screen.
  const WRAPPED = "‪Eddie Robson‬";
  const leaf = (label: string): DescribeNode => ({
    role: "AXStaticText",
    label,
    frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.02 },
    children: [],
  });
  const root: DescribeNode = {
    role: "ROOT",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [leaf(WRAPPED)],
  };

  it("findAll resolves the wrapped node from the plain authored text", () => {
    expect(findAll(root, { text: "Eddie Robson" })).toHaveLength(1);
  });

  it("a text/equals condition goes green on the folded label", () => {
    const matches = findAll(root, { text: "Eddie Robson" });
    expect(evaluateCondition("text", "Eddie Robson", matches, "equals")).toBe(true);
  });

  it("but a genuinely different name still fails, so the fold has not gone blind", () => {
    const matches = findAll(root, { text: "Eddie Robson" });
    expect(evaluateCondition("text", "Eddie Robertson", matches, "equals")).toBe(false);
  });
});
