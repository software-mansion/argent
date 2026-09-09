import { describe, expect, it } from "vitest";
import {
  compatibilityVariantIn,
  compatibilityVariantOf,
  confusableTextNote,
  confusableTextNoteIn,
  equalsCI,
  evaluateCondition,
  findAll,
  foldText,
  identifierMatches,
  quoteScreenText,
  includesCI,
  selectorMissNote,
  selectorToFrame,
  ignorableTextNote,
  textMatches,
  typographicVariantNote,
  uiTreeMatchInternals,
} from "../src/utils/ui-tree-match";
import type { DescribeNode } from "../src/tools/describe/contract";

// R10. The literal comparators fold the text before they compare it, so two
// strings that render identically compare equal. A plain `toLowerCase()` does not.

const NBSP = " ";
const NARROW_NBSP = " ";
const ZWSP = "​";
const ZWJ = "‍";
const BOM = "﻿";
const SOFT_HYPHEN = "­";
const VARIATION_SELECTOR_16 = "️";
const IDEOGRAPHIC_SPACE = "　";
// U+180B-U+180D and U+180F, the Mongolian block of `\p{Variation_Selector}`.
const MONGOLIAN_VARIATION_SELECTORS = ["᠋", "᠌", "᠍", "᠏"];

describe("foldText", () => {
  it("reduces every space-like codepoint to a plain space", () => {
    expect(foldText(`a${NBSP}b`)).toBe("a b");
    expect(foldText(`a${NARROW_NBSP}b`)).toBe("a b");
    expect(foldText(`a${IDEOGRAPHIC_SPACE}b`)).toBe("a b");
  });

  it("strips invisible formatting", () => {
    expect(foldText(`a${ZWSP}b`)).toBe("ab");
    expect(foldText(`${BOM}ab`)).toBe("ab");
    expect(foldText("a⁠b")).toBe("ab"); // word joiner
    expect(foldText("a⁤b")).toBe("ab"); // invisible plus
    expect(foldText("a⁯b")).toBe("ab"); // deprecated format control
  });

  it("keeps a soft hyphen, which PAINTS at a line break", () => {
    // A soft hyphen paints a hyphen when the line breaks at that point.
    expect(foldText(`so${SOFT_HYPHEN}ft`)).not.toBe("soft");
    expect(equalsCI(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toBe(false);
  });

  it("keeps U+180E, which suppresses Arabic cursive joining as ZWNJ does", () => {
    // Unicode 6.3 makes U+180E a zero-width format control, so it looks inert.
    // Between two Arabic letters it breaks the connected run, as U+200C does.
    expect(foldText("a᠎b")).not.toBe("ab");
    expect(equalsCI("ب᠎ب", "بب")).toBe(false);
  });

  it("composes a grapheme even when an invisible sat between base and combining mark", () => {
    // The fold removes the invisibles before it applies NFC. A ZWSP between "a"
    // and a combining acute blocks the composition.
    expect(foldText("a​́")).toBe(foldText("á"));
    expect(foldText("a​́")).toBe("á");
  });

  it("composes AFTER the case fold, for letters whose precomposed form is lowercase-only", () => {
    // `toLowerCase` does not preserve NFC, so the fold composes after the case
    // fold. U+01F0 has no uppercase precomposed form to compose to before it.
    const UPPER_DECOMPOSED = "J̌anko"; // J + combining caron
    const LOWER_PRECOMPOSED = "ǰanko"; // ǰ
    expect(foldText(UPPER_DECOMPOSED)).toBe(foldText(LOWER_PRECOMPOSED));
    expect(equalsCI(UPPER_DECOMPOSED, LOWER_PRECOMPOSED)).toBe(true);
    expect(includesCI(`say ${UPPER_DECOMPOSED} now`, LOWER_PRECOMPOSED)).toBe(true);
    expect(foldText("H̱i")).toBe(foldText("ẖi"));
  });

  it("keeps the joiners that BUILD a glyph", () => {
    // The transgender flag is U+1F3F3 VS16 ZWJ U+26A7 VS16 and renders as one
    // glyph. Without the joiners it renders as two glyphs.
    const FLAG = "\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F";
    const SPLIT = "\u{1F3F3}\u26A7";
    expect(foldText(FLAG)).not.toBe(foldText(SPLIT));
    expect(foldText(`a${ZWJ}b`)).not.toBe("ab");
    expect(foldText(`ok${VARIATION_SELECTOR_16}`)).not.toBe("ok");
  });

  it("keeps the MONGOLIAN variation selectors, the third block of the property", () => {
    // U+180B-U+180D and U+180F each pick which glyph form of the preceding
    // Mongolian letter is drawn, exactly as VS1-16 do elsewhere.
    for (const fvs of MONGOLIAN_VARIATION_SELECTORS) {
      expect(foldText(`ᠠ${fvs}`)).not.toBe("ᠠ");
      expect(equalsCI(`ᠭᠠ${fvs}ᠯ`, "ᠭᠠᠯ")).toBe(false);
    }
  });

  it("applies NFC, collapses whitespace runs, trims and lowercases", () => {
    expect(foldText("Cafe\u0301")).toBe(foldText("Café"));
    expect(foldText("  Save   Changes \n")).toBe("save changes");
    expect(foldText("Total:\t42")).toBe("total: 42");
  });

  it("keeps a LINE BREAK, which no number of spaces renders as", () => {
    // The collapse covers horizontal whitespace only, because a break moves the
    // glyphs after it. A fold that equates the labels gives the note nothing to
    // report either.
    expect(foldText("Sign\nin")).toBe("sign\nin");
    expect(equalsCI("Sign\nin", "Sign in")).toBe(false);
    expect(confusableTextNote("Sign\nin", "Sign in")).toBeUndefined();
    expect(includesCI("Line one\nLine two", "one Line")).toBe(false);
    expect(equalsCI("a\tb", "a b")).toBe(true);
    expect(equalsCI("Sign\u2028in", "Sign in")).toBe(false);
    expect(equalsCI("Sign\u0085in", "Sign in")).toBe(false);
  });

  it("still collapses a break run to ONE newline PER BREAK, spaces around it included", () => {
    // CRLF is one break, and the indentation beside a break is invisible.
    expect(foldText("Line one\r\nLine two")).toBe(foldText("Line one\nLine two"));
    expect(foldText("Line one \n  Line two")).toBe("line one\nline two");
  });

  it("keeps a BLANK LINE, which one break does not render as", () => {
    // A blank line is visible, so the fold counts the breaks in a run and does
    // not collapse them to one. It still absorbs the indentation between them.
    expect(foldText("Line one\n\nLine two")).toBe("line one\n\nline two");
    expect(equalsCI("Line one\n\nLine two", "Line one\nLine two")).toBe(false);
    expect(includesCI("Line one\n\nLine two", "one\nLine")).toBe(false);
    expect(equalsCI("Line one\n \nLine two", "Line one\n\nLine two")).toBe(true);
    expect(equalsCI("Line one\r\n\r\nLine two", "Line one\n\nLine two")).toBe(true);
    expect(confusableTextNote("Line one\n\nLine two", "Line one\nLine two")).toBeUndefined();
  });

  it("counts an EDGE break too, so a needle's own edge stays a break", () => {
    // foldText trims an edge break away, so the two whole-string comparators
    // are unaffected. The untrimmed foldLoose keeps it, and a needle's edge is
    // an interior position of the label, so the two sides must agree there.
    expect(foldText("\nSign in\n")).toBe("sign in");
    expect(includesCI("  Save   Changes \n", "Changes ")).toBe(true);
    expect(equalsCI("Sign in\n", "Sign in")).toBe(true);
    // A needle copied character-for-character out of a two-line label matches it.
    expect(includesCI("Line one\nLine two", "\nLine two")).toBe(true);
    expect(includesCI("Line one\nLine two", "Line one\n")).toBe(true);
    // And a needle asking for a break does not match a label that has none.
    expect(includesCI("bar foo", "\nfoo")).toBe(false);
    expect(includesCI("bar foo", "bar\n")).toBe(false);
  });

  it("folds the three that move only WHERE the line breaks, a documented cost", () => {
    // Measured in Chromium at 20px text: "ตา<ZWSP>กลม" draws ตา / กลม and
    // "ตาก<ZWSP>ลม" draws ตาก / ลม, while U+2060 and U+FEFF move the break the
    // bare CJK string takes. Dropping a stray ZWSP is the point of the fold, so
    // this is deliberate — but `equals` therefore cannot pin the segmentation,
    // and the docs say so rather than claiming the set is inert.
    expect(equalsCI("ตา​กลม", "ตาก​ลม")).toBe(true);
    expect(equalsCI("日本語", "日本⁠語")).toBe(true);
    expect(equalsCI("日本語", "日本﻿語")).toBe(true);
  });

  it("keeps COMPATIBILITY variants distinct — the eye can see those", () => {
    // NFC, not NFKC: NFKC equates a blackletter name with the plain account.
    // Each case asserts positively too, because a no-change fold passes `not.toBe`.
    expect(foldText("𝕴𝖓𝖋𝖊𝖗𝖓𝖆𝖙𝖗𝖎𝖝")).toBe("𝕴𝖓𝖋𝖊𝖗𝖓𝖆𝖙𝖗𝖎𝖝".toLowerCase());
    expect(foldText("𝕴𝖓𝖋𝖊𝖗𝖓𝖆𝖙𝖗𝖎𝖝")).not.toBe(foldText("Infernatrix"));
    expect(foldText("Ａ")).toBe("ａ"); // fullwidth survives, lowercased
    expect(foldText("Ａ")).not.toBe(foldText("A"));
    expect(foldText("ﬁle")).toBe("ﬁle"); // ligature survives
    expect(foldText("ﬁle")).not.toBe(foldText("file"));
    expect(foldText("x²")).toBe("x²"); // superscript survives
    expect(foldText("x²")).not.toBe(foldText("x2"));
  });

  it("leaves visibly different text different", () => {
    expect(foldText("Save")).toBe("save");
    expect(foldText("Saved")).toBe("saved");
    expect(foldText("Save")).not.toBe(foldText("Saved"));
    expect(foldText("PLN 42.00")).toBe("pln 42.00");
    expect(foldText("PLN 42.00")).not.toBe(foldText("PLN 42.0"));
  });

  it("bounds itself at its cap, and keeps folding correctly afterwards", () => {
    // The cache rotates its young generation at FOLD_CACHE_MAX entries. The
    // loop finds the bound, so a change to the cap cannot make the test miss it.
    const probe = `Amount, PLN${NBSP}42.00`;
    const before = foldText(probe);
    const LIMIT = 200_000; // far above any plausible cap; a bound, not a target
    let peak = 0;
    let rotated = false;
    let previous = uiTreeMatchInternals.foldCacheSize();
    for (let i = 0; i < LIMIT; i++) {
      foldText(`filler-${i}`);
      const size = uiTreeMatchInternals.foldCacheSize();
      // Two generations, so the total falls only when the older one is dropped.
      rotated = rotated || size < previous;
      peak = Math.max(peak, size);
      previous = size;
    }
    expect(rotated).toBe(true);
    expect(peak).toBeLessThan(LIMIT / 2);
    expect(foldText(probe)).toBe(before);
    expect(equalsCI(probe, "Amount, PLN 42.00")).toBe(true);
    // A bidi-sensitive string still takes the conditional path after a rotation.
    expect(equalsCI("5‏-3", "5-3")).toBe(false);
  });

  it("keeps a warm entry through a wave of keys that never repeat", () => {
    // A screen with a ticking relative time on every row emits more distinct
    // strings per pass than the cap. One map cleared wholesale lost every stable
    // label beside them, and the next pass refolded the whole tree cold - every
    // pass, since each wave wiped the map again.
    const stable = `Amount, PLN${NBSP}42.00 warm-probe`;
    const expected = foldText(stable);
    const WAVE = 40_000; // more than the cap, so each pass rotates at least once
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < WAVE; i++) foldText(`row ${pass}-${i} - 2 minutes ago`);
      const folded = uiTreeMatchInternals.foldCacheMisses();
      expect(foldText(stable)).toBe(expected);
      // Read from the cache, not folded again.
      expect(uiTreeMatchInternals.foldCacheMisses()).toBe(folded);
    }
  });

  it("bounds itself by CHARACTERS as well, because a key holds the original string", () => {
    // An entry is not a fixed size: the key retains the string that was folded,
    // and one card's label has reached 11,532 characters. Counting entries alone
    // let the map hold megabytes of dead originals for the process's lifetime.
    const LONG = 12_000;
    const ENTRIES = 300; // far below the entry cap, far above the character cap
    for (let i = 0; i < ENTRIES; i++) foldText(`${i}`.padEnd(LONG, "x"));
    expect(uiTreeMatchInternals.foldCacheSize()).toBeLessThan(ENTRIES);
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

  describe("a boundary space in a `contains` needle still constrains", () => {
    // `contains: "Taps: 3"` also matches "Taps: 30", so an author writes a
    // trailing space. The fold keeps that space.
    it("does not let a trailing space match a longer word", () => {
      expect(includesCI("Saved successfully", "Save ")).toBe(false);
      expect(includesCI("Taps: 30", "Taps: 3 ")).toBe(false);
    });

    it("does not let a leading space match mid-word", () => {
      expect(includesCI("NOTOK", " OK")).toBe(false);
    });

    it("still matches when the boundary is really there", () => {
      expect(includesCI("Save Changes", "Save ")).toBe(true);
      expect(includesCI("Taps: 3 times", "Taps: 3 ")).toBe(true);
      expect(includesCI("NOT OK", " OK")).toBe(true);
      expect(includesCI(`Taps:${NBSP}3${NBSP}times`, "Taps: 3 ")).toBe(true);
    });

    it("still ignores the label's own incidental outer whitespace", () => {
      expect(includesCI("  Save   Changes \n", "Save Changes")).toBe(true);
      expect(includesCI("  Save   Changes \n", "Changes ")).toBe(true);
    });

    it("keeps trimming an EQUALS comparison, where outer space is noise", () => {
      expect(equalsCI("  Save   Changes \n", "Save Changes")).toBe(true);
      expect(foldText("  Save   Changes \n")).toBe("save changes");
    });

    it("treats a needle that is nothing BUT whitespace as a real constraint", () => {
      // The loose fold leaves " " non-empty, so it constrains the match to a
      // label that shows a space. The trimmed fold rejects it outright.
      expect(includesCI("Save Changes", " ")).toBe(true);
      expect(includesCI("SaveChanges", " ")).toBe(false);
      expect(includesCI("Save Changes", "\t\n ")).toBe(true); // the run folds to " "
    });
  });

  it("never folds a `matches` (regex) comparison — a pattern carries its precision", () => {
    expect(textMatches(`PLN${NBSP}42`, "PLN 42", "matches")).toBe(false);
    expect(textMatches(`PLN${NBSP}42`, "PLN 42", "contains")).toBe(true);
    expect(textMatches("‪@bsky.app‬", "^@bsky\\.app$", "matches")).toBe(false);
    expect(textMatches("@bsky.app", "^@bsky\\.app$", "matches")).toBe(true);
    expect(textMatches("HOME", "^Home$", "matches")).toBe(false);
    expect(textMatches("HOME", "Home", "equals")).toBe(true);
  });

  it("does NOT fold identifiers — a machine key is not read off a screen", () => {
    // An identifier never reaches a screen, so two keys that differ are two keys.
    expect(identifierMatches(`submit${ZWSP}`, "submit")).toBe(false);
    expect(identifierMatches("com.example.app:id/submit", `sub${ZWSP}mit`)).toBe(false);
    expect(identifierMatches("row:id/save ", "row:id/save")).toBe(false);
    expect(identifierMatches("Submit", "submit")).toBe(true);
    expect(identifierMatches("com.example.app:id/submit", "submit")).toBe(true);
    expect(identifierMatches("autosave-banner", "save")).toBe(false);
  });

  it("resolves the `:id/` suffix path exactly, including its refusals", () => {
    expect(identifierMatches("com.example.app:id/save-button", "save-button")).toBe(true);
    expect(identifierMatches("com.example.app:id/Save-Button", "save-button")).toBe(true);
    expect(identifierMatches("com.example.app:id/save-button", "button")).toBe(false);
    expect(identifierMatches(`com.example.app:id/save${ZWSP}-button`, "save-button")).toBe(false);
    // A needle of only whitespace names nothing, so the suffix rule refuses it.
    expect(identifierMatches("com.example.app:id/save-button", " ")).toBe(false);
  });
});

describe("bidi wrappers", () => {
  // An app that renders user-supplied names wraps each one in LTR controls. An
  // LTR wrapper around Latin text is the common real case.
  const LRE = "‪"; // U+202A LEFT-TO-RIGHT EMBEDDING
  const PDF = "‬"; // U+202C POP DIRECTIONAL FORMATTING
  const LRI = "⁦"; // U+2066 LEFT-TO-RIGHT ISOLATE
  const PDI = "⁩"; // U+2069 POP DIRECTIONAL ISOLATE

  it("equates a bidi-wrapped handle with the plain one", () => {
    expect(equalsCI(`${LRE}@bsky.app${PDF}`, "@bsky.app")).toBe(true);
    expect(equalsCI(`${LRI}@bsky.app${PDI}`, "@bsky.app")).toBe(true);
    expect(includesCI(`${LRE}Jane Doe${PDF} posted`, "Jane Doe")).toBe(true);
    expect(equalsCI("‭@bsky.app‬", "@bsky.app")).toBe(true);
    expect(equalsCI("⁨@bsky.app⁩", "@bsky.app")).toBe(true);
  });

  it("does not swallow the narrow no-break space next to that range", () => {
    // U+202F is a space, not a format control, so it folds to " ".
    expect(foldText(`a${NARROW_NBSP}b`)).toBe("a b");
  });

  // A control that imposes a right-to-left order changes what the screen shows,
  // even in plain ASCII. Each comment below gives the Chromium rendering.
  describe("never folds a control that reorders the glyphs", () => {
    const RLM = "‏"; // U+200F
    const ALM = "؜"; // U+061C
    const RLO = "‮"; // U+202E
    const RLE = "‫"; // U+202B
    const RLI = "⁧"; // U+2067

    it("leaves a bidi mark that moves plain ASCII digits", () => {
      expect(equalsCI(`5${RLM}-3`, "5-3")).toBe(false); // renders `53-`
      expect(equalsCI(`5${ALM}-3`, "5-3")).toBe(false); // renders `53-`
      expect(equalsCI(`v1${RLM}.2.3`, "v1.2.3")).toBe(false); // renders `v12.3.`
    });

    it("leaves an override that reverses a filename extension", () => {
      // The screen shows `reportexe.txt`.
      expect(equalsCI(`report${RLO}txt.exe`, "reporttxt.exe")).toBe(false);
      expect(includesCI(`report${RLO}txt.exe`, "reporttxt.exe")).toBe(false);
    });

    it("leaves a balanced RTL wrapper, which renders reversed", () => {
      expect(equalsCI(`${RLO}abc${PDF}`, "abc")).toBe(false); // renders `cba`
      expect(equalsCI(`${RLE}abc${PDF}`, "abc")).toBe(false);
      expect(equalsCI(`${RLI}abc${PDI}`, "abc")).toBe(false);
    });

    it("stops folding the LTR controls too once the string carries RTL text", () => {
      // The wrapper forces an LTR base direction on RTL text, so the word order changes.
      expect(equalsCI(`${LRE}عمر Smith 2024${PDF}`, "عمر Smith 2024")).toBe(false);
      expect(equalsCI(`${LRI}שלום${PDI}`, "שלום")).toBe(false);
      // A fold of one half of a pair changes the string, not the rendering.
      expect(equalsCI(`${RLE}abc${PDF}def`, "abcdef")).toBe(false);
    });

    it("decides the LTR strip once per COMPARISON, so a copied needle stays a substring", () => {
      // The strip depends on the whole string, so a label with one RTL word
      // keeps wrappers that a fragment of it loses. The comparison decides once.
      const HEB = "שלום";
      const label = `${LRE}@alice${PDF} ${LRE}@bob${PDF} ${HEB}`;
      const needle = `${LRE}@alice${PDF} ${LRE}@bob${PDF}`;
      expect(label.includes(needle)).toBe(true); // a literal substring
      expect(includesCI(label, needle)).toBe(true);
      // Control: no RTL word at all, so both sides strip.
      expect(includesCI(`${LRE}@alice${PDF} ${LRE}@bob${PDF} hello`, needle)).toBe(true);
      expect(equalsCI(`${LRE}${HEB}${PDF}`, HEB)).toBe(false);
    });

    it("matches a wrapper half only where the label carries that half", () => {
      // What the skill reference states about a needle copied out of a wrapped
      // label. A half at the label's own edge matches; the same half anywhere
      // else does not, and the bare text always does.
      const HEB = "שלום";
      const label = `${LRE}@alice ${HEB}${PDF}`;
      expect(includesCI(label, `${LRE}@alice`)).toBe(true);
      expect(includesCI(label, `${HEB}${PDF}`)).toBe(true);
      expect(includesCI(label, `alice ${PDF}`)).toBe(false);
      expect(includesCI(label, `${LRE}alice`)).toBe(false);
      expect(includesCI(label, "@alice")).toBe(true);
    });

    it("still folds an LTR wrapper around text that merely LOOKS exotic", () => {
      // No strong RTL character anywhere, so the wrapper is inert.
      expect(equalsCI(`${LRE}Ελένη Παπαδοπούλου${PDF}`, "Ελένη Παπαδοπούλου")).toBe(true);
      expect(equalsCI(`${LRE}日本語のなまえ${PDF}`, "日本語のなまえ")).toBe(true);
    });
  });
});

describe("compatibilityVariantOf", () => {
  // NFC keeps these apart on purpose, so a miss needs an explanation, not a
  // fold. An author types `...` where the app renders one U+2026.
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

describe("a miss with BOTH causes is explained by both", () => {
  // The two questions used to partition the misses: a never-folded invisible
  // survives NFKC and defeats the typographic gate, while the rendered `…`
  // outlives the ignorable strip and defeats the codepoint gate. Hyphenation
  // and truncation are plausible together, so the pair reached a bare reason.
  const SHY = "­";
  const RLM = "‏";

  it("names the code points AND the typographic variant, in that order", () => {
    const note = confusableTextNote(`Load${SHY}ing…`, "Loading...")!;
    expect(note).toBeDefined();
    expect(note).toContain("U+00AD");
    expect(note).toContain("typographic variant");
    expect(note.indexOf("U+00AD")).toBeLessThan(note.indexOf("typographic variant"));
  });

  it("does the same for the substring comparator, which is the default", () => {
    const note = confusableTextNoteIn(`${RLM}Loa${RLM}ding…`, "Loading...")!;
    expect(note).toContain("U+200F");
    expect(note).toContain("typographic variant");
  });

  it("names the character that blocks, not every ignorable in the label", () => {
    // With the variant left out of the necessity test, no single character was
    // ever found to block and the note fell back to listing them all.
    const note = confusableTextNote(`${RLM}Load${SHY}ing…`, `${RLM}Loading...`)!;
    expect(note).toContain("U+00AD");
    expect(note).toContain("changes what IS drawn");
  });

  it("still explains a selector miss that carries both", () => {
    const nodes: DescribeNode[] = [
      {
        role: "button",
        label: `Load${SHY}ing…`,
        frame: { x: 0, y: 0, width: 0.4, height: 0.08 },
        children: [],
      },
    ];
    const note = selectorMissNote(nodes, "Loading...")!;
    expect(note).toContain("U+00AD");
    expect(note).toContain("typographic variant");
  });

  it("lets the variant clause account for the rest, not the case/spacing one", () => {
    // What is left of the pair IS the typographic variant, so the two clauses
    // would contradict each other.
    const note = confusableTextNote(`Load${SHY}ing…`, "Loading...")!;
    expect(note).toContain("typographic variant");
    expect(note).not.toContain("what is left differs");
  });

  it("asks the invisible question of every candidate before the typographic one", () => {
    // The rationale promises the codepoint answer first, because it names exact
    // characters. Nothing enforced it: swapping the two loops in
    // selectorMissNote left the whole selector suite green, while an author
    // whose screen holds both kinds of near-miss got the vaguer answer.
    const CGJ = "\u034F";
    const leaf = (label: string, identifier: string): DescribeNode => ({
      role: "button",
      label,
      identifier,
      frame: { x: 0, y: 0, width: 0.4, height: 0.08 },
      children: [],
    });
    const variantOnly = leaf("Ｓave changes", "fullwidth"); // a typographic variant
    const invisibleOnly = leaf(`Save${CGJ} changes`, "cgj"); // a blocking invisible
    for (const candidates of [
      [variantOnly, invisibleOnly],
      [invisibleOnly, variantOnly],
    ]) {
      const note = selectorMissNote(candidates, "Save changes")!;
      expect(note).toContain("U+034F");
      expect(note).not.toContain("typographic");
    }
  });

  it("leaves a single-cause miss with its single explanation", () => {
    expect(confusableTextNote(`Load${SHY}ing`, "Loading")).not.toContain("typographic variant");
    expect(confusableTextNote("Loading…", "Loading...")).toBeUndefined();
    expect(compatibilityVariantOf("Loading…", "Loading...")).toBe(true);
  });
});

describe("confusableTextNote", () => {
  // The note explains an invisible character that the fold does not list.
  // Anything the fold handles compares equal, so no check fails.
  const CGJ = "͏"; // U+034F COMBINING GRAPHEME JOINER
  const RLM = "‏"; // U+200F RIGHT-TO-LEFT MARK

  it("names the differing codepoints when the strings only look equal", () => {
    const note = confusableTextNote(`PLN 42${CGJ}`, "PLN 42")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+034F");
  });

  it("catches U+034F, which is Mn and so escaped a category-Cf test", () => {
    // U+034F is zero-width and unpainted, but the fold keeps it, because it
    // blocks canonical reordering. It is category Mn, not category Cf.
    expect(equalsCI(`Save${CGJ}`, "Save")).toBe(false);
    expect(confusableTextNote(`Save${CGJ}`, "Save")).toContain("U+034F");
  });

  it("asks its gate through the COMPARATOR, so a folded-away difference cannot silence it", () => {
    // The gate asks the comparator that failed, and the comparator folds both
    // sides. A raw `===` gate lets an NBSP beside the CGJ silence the note.
    const label = `Amount${CGJ}${NBSP}PLN${NBSP}42`;
    expect(equalsCI(label, "Amount PLN 42")).toBe(false);
    expect(confusableTextNote(label, "Amount PLN 42")).toContain("U+034F");
    expect(equalsCI(`Kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toBe(false);
    expect(confusableTextNote(`Kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toContain(
      "changes what IS drawn"
    );
    // A compatibility variant is a glyph the reader sees, so the note does not
    // call it invisible. foldText applies NFC, never NFKC, so it fails the gate.
    expect(confusableTextNote(`\uFB01le${ZWSP}`, "file")).toBeUndefined();
    expect(confusableTextNote(`Add\u2026${ZWSP}`, "Add...")).toBeUndefined();
    expect(confusableTextNote(`${ZWSP}${ZWSP}`, ZWSP)).toContain("U+200B");
  });

  it("has a SUBSTRING form, so the note is not absent on the default comparator", () => {
    // The whole-string gate applies under `contains` only when the needle spans
    // the whole label. The substring form covers a proper substring.
    expect(includesCI(`Save${CGJ}Changes now`, "SaveChanges")).toBe(false);
    expect(confusableTextNote(`Save${CGJ}Changes now`, "SaveChanges")).toBeUndefined();
    const note = confusableTextNoteIn(`Save${CGJ}Changes now`, "SaveChanges")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+034F");
    expect(confusableTextNoteIn(`kraft${SOFT_HYPHEN}fahrzeug GmbH`, "kraftfahrzeug")).toContain(
      "changes what IS drawn"
    );
    expect(confusableTextNoteIn("Totally other text", "SaveChanges")).toBeUndefined();
    expect(confusableTextNoteIn("Save Changes now", "Save")).toBeUndefined();
  });

  it("picks the lead from the character that BLOCKED the needle, not from the label", () => {
    // Under a substring test the label carries ignorables that the needle never
    // reaches. An unrelated RLM does not make a CGJ miss read as a reordering.
    const blocked = `Total ${RLM}42. Save${CGJ}Changes`;
    // A drop of the CGJ alone makes the needle match. A drop of the RLM does not.
    expect(includesCI(`Total ${RLM}42. SaveChanges`, "SaveChanges")).toBe(true);
    expect(includesCI(`Total 42. Save${CGJ}Changes`, "SaveChanges")).toBe(false);
    const note = confusableTextNoteIn(blocked, "SaveChanges")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).not.toContain("REORDERS");
    expect(note).toContain("U+200F");
    expect(confusableTextNoteIn(`Save${RLM}Changes`, "SaveChanges")).toContain("REORDERS");
  });

  it("bounds the codepoint dump, and windows it on the blocker", () => {
    // Under `contains` the element sizes the dump, and assertText prefers the
    // aggregated subtreeText. A 1,412-character card gives an 11,532-character reason.
    const card = `${"Total 42. ".repeat(140)}Save${CGJ}Changes`;
    const note = confusableTextNoteIn(card, "SaveChanges")!;
    expect(card.length).toBeGreaterThan(1400);
    expect(note.length).toBeLessThan(700);
    // The window sits on the blocker, because its position in the label matters.
    expect(note).toContain("U+034F");
    expect(note).toContain("…");
    const short = confusableTextNote(`Save${CGJ}Changes`, "SaveChanges")!;
    expect(short).not.toContain("…");
    expect(short).toContain("U+0053 U+0061 U+0076 U+0065 U+034F");
  });

  it("windows BOTH dumps on the same region, not each on its own centre", () => {
    // Only one side holds the blocker, so a per-string centre sent the other
    // side back to index 0 and the two lists described different parts of the
    // label — while the note's `actual [...] vs expected [...]` shape invites
    // reading them side by side.
    const lead = "Your order was placed on 14 March and will arrive by ";
    const actual = `${lead}Save${CGJ}Changes tail`;
    const expected = `${lead}SaveChanges tail`;
    expect([...actual].length).toBeGreaterThan(48);
    const note = confusableTextNote(actual, expected)!;
    const [, gotActual, gotExpected] = /actual \[(.+)\] vs expected \[(.+)\]/.exec(note)!;
    // Both windows reach the blocker's neighbourhood: each ends on "tail", and
    // the expected side shows the position the CGJ occupies in the actual one.
    const TAIL = "U+0074 U+0061 U+0069 U+006C";
    expect(gotActual.endsWith(TAIL)).toBe(true);
    expect(gotExpected.endsWith(TAIL)).toBe(true);
    expect(gotActual).toContain("U+0065 U+034F U+0043");
    expect(gotExpected).toContain("U+0065 U+0043");
  });

  it("stays silent for a prepended concatenation mark, which is NOT ignorable", () => {
    // U+110BD is category Cf, but it changes how the digits after it render.
    expect(confusableTextNote("PLN 42\u{110BD}", "PLN 42")).toBeUndefined();
  });

  it("does not call a ZWJ emoji sequence an invisible difference", () => {
    // The flag is one glyph and the broken sequence is two, a visible difference.
    const FLAG = "\u{1F3F3}️‍⚧️";
    const BROKEN = "\u{1F3F3}️⚧️";
    expect(confusableTextNote(FLAG, BROKEN)).toBeUndefined();
    expect(confusableTextNote(`ok${VARIATION_SELECTOR_16}`, "ok")).toBeUndefined();
    expect(confusableTextNote("a‌b", "ab")).toBeUndefined();
  });

  it("says a directional difference REORDERS rather than calling it invisible", () => {
    // U+200F draws nothing, but `5<RLM>-3` renders as `53-`.
    const note = confusableTextNote("5‏-3", "5-3")!;
    expect(note).toContain("REORDERS");
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("U+200F");
  });

  it("says a soft hyphen is a RENDERING difference rather than calling it invisible", () => {
    // SHY is Default_Ignorable, but `kraft<SHY>fahrzeug` paints `kraft-` at a break.
    expect(equalsCI(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toBe(false);
    const note = confusableTextNote(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")!;
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("changes what IS drawn");
    expect(note).toContain("U+00AD");
  });

  it("never claims the quoted string is DRAWN, because a label may be an a11y name", () => {
    // `label` is the accessibility name on every adapter that feeds the notes,
    // so on an icon-only control it is the node's only text and the screen
    // draws none of it. A soft hyphen in a name that is never laid out paints
    // no hyphen either, so "the screen and the text really do differ" was the
    // opposite of the truth for the very string being quoted.
    const note = confusableTextNote(`Con${SOFT_HYPHEN}firm`, "Confirm")!;
    expect(note).toContain("changes what IS drawn");
    expect(note).toContain("a real difference");
    expect(note).not.toContain("the screen and the text");
    expect(typographicVariantNote("Loading…")).toContain(`the element's text is "Loading…"`);
    expect(typographicVariantNote("Loading…")).not.toContain("the screen does show");
  });

  it("says the same of U+180E, which does ZWNJ's job", () => {
    // U+180E breaks the same Arabic cursive run that ZWNJ breaks.
    expect(equalsCI("ب᠎ب", "بب")).toBe(false);
    const note = confusableTextNote("ب᠎ب", "بب")!;
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("changes what IS drawn");
    expect(note).toContain("U+180E");
  });

  it("stays SILENT on a Mongolian variation selector, as it does on VS1-16", () => {
    // An FVS picks the glyph form of the letter before it, so a difference in
    // one is a rendering difference. The note must not report it as invisible.
    for (const fvs of MONGOLIAN_VARIATION_SELECTORS) {
      expect(confusableTextNote(`ᠭᠠ${fvs}ᠯ`, "ᠭᠠᠯ")).toBeUndefined();
      expect(confusableTextNoteIn(`ᠭᠠ${fvs}ᠯ`, "ᠭᠠᠯ")).toBeUndefined();
    }
  });

  it("lets the reordering lead win a difference that is both", () => {
    const note = confusableTextNote(`5‏-3${SOFT_HYPHEN}`, "5-3")!;
    expect(note).toContain("REORDERS");
    expect(note).not.toContain("differ only in invisible characters");
  });

  it("still calls a shared soft hyphen's OTHER difference invisible", () => {
    const note = confusableTextNote(
      `kraft${SOFT_HYPHEN}fahr${ZWSP}zeug`,
      `kraft${SOFT_HYPHEN}fahrzeug`
    )!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+200B");
  });

  it("still calls a shared directional wrapper's OTHER difference invisible", () => {
    const note = confusableTextNote("‪Save​‬", "‪Save‬")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+200B");
  });

  it("names a MOVED control, which a count of the two strings cannot see", () => {
    const note = confusableTextNote("report\u202Etxt.exe", "reporttxt.exe\u202E")!;
    expect(note).toContain("REORDERS");
    expect(note).not.toContain("differ only in invisible characters");
    const shy = confusableTextNote(`kraft${SOFT_HYPHEN}fahrzeug`, `kraftfahrzeug${SOFT_HYPHEN}`)!;
    expect(shy).toContain("changes what IS drawn");
    expect(confusableTextNote("\u180Eبب", "بب\u180E")).toContain("changes what IS drawn");
  });

  it("says nothing when the strings are equal, or visibly different", () => {
    expect(confusableTextNote("PLN 42", "PLN 42")).toBeUndefined();
    expect(confusableTextNote("PLN 42", "PLN 43")).toBeUndefined();
  });

  it("does not call a CASE difference invisible", () => {
    // The literal comparators fold case, so such a pair compares equal and
    // never reaches the note. A difference of case is visible in any event.
    expect(confusableTextNote("Home", "HOME")).toBeUndefined();
  });

  it("does not call an NFKC compatibility difference invisible", () => {
    expect(confusableTextNote("ﬁle", "file")).toBeUndefined();
  });

  it("drops the word ONLY when a case difference stands beside the invisible one", () => {
    // The gate accepts a pair the COMPARATOR equates, so case can differ too -
    // and the dumps print it. Claiming the strings differ only in invisible
    // characters is then false against the two lists in the same sentence.
    const note = confusableTextNote(`Home${CGJ}`, "home");
    expect(note).toContain("U+0048");
    expect(note).toContain("U+0068");
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("differ in invisible characters");
    expect(note).toContain("what is left differs in case, spacing or composition");
  });

  it("keeps ONLY when nothing but the invisible characters differs", () => {
    const note = confusableTextNote(`home${CGJ}`, "home");
    expect(note).toContain("differ only in invisible characters");
    expect(note).not.toContain("what is left differs");
  });

  it("drops the word ONLY from the DIRECTIONAL lead on the same grounds", () => {
    const note = confusableTextNote(`Home${RLM}`, "home");
    expect(note).toContain("differ in directional formatting");
    expect(note).not.toContain("differ only in directional formatting");
    expect(note).toContain("what is left differs in case, spacing or composition");
  });

  it("says nothing for a difference the fold already absorbs", () => {
    expect(equalsCI(`PLN${NBSP}42`, "PLN 42")).toBe(true);
    expect(confusableTextNote(`PLN${NBSP}42`, "PLN 42")).toBeUndefined();
  });
});

describe("a needle that folds away to nothing", () => {
  // The fold can turn a non-empty selector value into an empty one, and an
  // empty needle is no constraint: `"".includes()` is true of every string.
  // A whitespace-only value folds loosely to " " and still constrains a match.
  const BLANK_NEEDLES = ["​", "‪‬", "﻿"];
  const WHITESPACE_NEEDLES = [" ", " ", "\t\n "];

  it.each(BLANK_NEEDLES)("includesCI(%j) matches nothing", (needle) => {
    expect(includesCI("Button", needle)).toBe(false);
    expect(includesCI("anything at all", needle)).toBe(false);
  });

  it.each([...BLANK_NEEDLES, ...WHITESPACE_NEEDLES])(
    "identifierMatches(%j) matches nothing",
    (needle) => {
      expect(identifierMatches("save-button", needle)).toBe(false);
      expect(identifierMatches("com.example.app:id/save-button", needle)).toBe(false);
    }
  );

  it.each(BLANK_NEEDLES)("equalsCI(_, %j) equals nothing — not even a textless node", (needle) => {
    // The same guard on the exact comparator: without it `equalsCI("", ZWSP)`
    // is true, and a `text`/`equals` check passes against a textless element.
    expect(equalsCI("", needle)).toBe(false);
    expect(equalsCI(undefined, needle)).toBe(false);
    expect(equalsCI("Button", needle)).toBe(false);
  });

  it.each(WHITESPACE_NEEDLES)("keeps %j answerable rather than unsatisfiable", (needle) => {
    // The guard reads the untrimmed fold, so one space stays distinct from no
    // text. The trimmed fold rejects a needle equal to its own label.
    expect(equalsCI(needle, needle)).toBe(true);
    expect(equalsCI(" ", needle)).toBe(true);
    expect(equalsCI("", needle)).toBe(false);
    expect(equalsCI(undefined, needle)).toBe(false);
    expect(equalsCI("Button", needle)).toBe(false);
    expect(includesCI("Save Changes", needle)).toBe(true);
    expect(includesCI("SaveChanges", needle)).toBe(false);
  });

  it("blocks the two inputs its gate is actually reachable for", () => {
    // identifierMatches does not fold, so the body already refuses every blank
    // needle above. The gate decides two other inputs. First, a blank id and a
    // blank needle, which `" " === " "` accepts.
    expect(identifierMatches(" ", " ")).toBe(false);
    expect(identifierMatches("\u00a0", "\u00a0")).toBe(false);
    // Second, an empty needle against an id that ends in `:id/`, where the
    // suffix rule accepts every such id. The schema `.min(1)` also blocks it.
    expect(identifierMatches("com.example.app:id/", "")).toBe(false);
    expect(identifierMatches("com.example.app:id/save-button", "")).toBe(false);
  });

  it("still matches a real value, so the guard is not over-broad", () => {
    expect(includesCI("Button", "butt")).toBe(true);
    expect(identifierMatches("com.example.app:id/save-button", "save-button")).toBe(true);
    expect(equalsCI("Save", "save")).toBe(true);
    expect(equalsCI("‪@bsky.app‬", "@bsky.app")).toBe(true);
  });
});

describe("ranking prefers the literal spelling over one only the fold equates", () => {
  // The fold locates an element that an author cannot otherwise name. Ranking
  // separates two matches, or "smallest frame wins" takes a 28x28 icon.
  const icon: DescribeNode = {
    role: "button",
    label: `Sign${NBSP}in`,
    identifier: "icon",
    frame: { x: 0, y: 0, width: 0.023, height: 0.041 },
    children: [],
  };
  const cta: DescribeNode = {
    role: "button",
    value: "Sign in",
    identifier: "cta",
    frame: { x: 0, y: 0.07, width: 0.35, height: 0.102 },
    children: [],
  };
  const screen = (children: DescribeNode[]): DescribeNode => ({
    role: "ROOT",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });

  it("resolves the CTA, not the smaller folded-equal icon", () => {
    expect(selectorToFrame(screen([icon, cta]), { text: "Sign in" })).toMatchObject({
      width: 0.35,
    });
    // Order-independent: the grade decides, not the position in the children.
    expect(selectorToFrame(screen([cta, icon]), { text: "Sign in" })).toMatchObject({
      width: 0.35,
    });
  });

  it("still resolves a folded-only match when it is the ONLY one", () => {
    expect(selectorToFrame(screen([icon]), { text: "Sign in" })).toMatchObject({
      width: 0.023,
    });
  });

  it("grades a folded-exact match above one that merely CONTAINS the needle", () => {
    // The scale is literal, then folded, then substring. A grade on the literal
    // comparison leaves the folded node at zero, tied with the substring node.
    const foldedExact: DescribeNode = {
      role: "button",
      label: `Sign${NBSP}in`,
      identifier: "cta",
      frame: { x: 0, y: 0, width: 0.8, height: 0.09 },
      children: [],
    };
    const substring: DescribeNode = {
      role: "link",
      label: "Sign in with Apple",
      identifier: "apple",
      frame: { x: 0, y: 0.2, width: 0.4, height: 0.04 },
      children: [],
    };
    expect(selectorToFrame(screen([foldedExact, substring]), { text: "Sign in" })).toMatchObject({
      width: 0.8,
    });
    expect(selectorToFrame(screen([substring, foldedExact]), { text: "Sign in" })).toMatchObject({
      width: 0.8,
    });
  });

  it("grades a regex that consumes the WHOLE string as a literal match", () => {
    // A regex never folds, so full consumption is the literal grade, worth two
    // points. The whole-string node is larger and has the weaker role grade.
    const whole: DescribeNode = {
      role: `button${NBSP}`, // folded-equal to the selector's role, grade 1
      label: "Sign in",
      identifier: "whole",
      frame: { x: 0, y: 0, width: 0.4, height: 0.08 },
      children: [],
    };
    const partial: DescribeNode = {
      role: "button", // literal, grade 2
      label: "Sign in now",
      identifier: "partial",
      frame: { x: 0, y: 0.3, width: 0.02, height: 0.02 },
      children: [],
    };
    const selector = { textMatches: "Sign in", role: "button" };
    expect(selectorToFrame(screen([whole, partial]), selector)).toMatchObject({ width: 0.4 });
    expect(selectorToFrame(screen([partial, whole]), selector)).toMatchObject({ width: 0.4 });
  });

  it("grades an EXACT identifier above one matched by its resource-id suffix", () => {
    // identifierMatches does not fold, so only two spellings reach ranking: the
    // exact id and the `:id/` suffix. The exact node here is the larger one.
    const exact: DescribeNode = {
      ...cta,
      identifier: "save",
      frame: { x: 0, y: 0.5, width: 0.4, height: 0.08 },
    };
    const suffix: DescribeNode = {
      ...icon,
      identifier: "com.example.app:id/save",
      frame: { x: 0, y: 0, width: 0.02, height: 0.02 },
    };
    expect(selectorToFrame(screen([exact, suffix]), { identifier: "save" })).toMatchObject({
      width: 0.4,
    });
    expect(selectorToFrame(screen([suffix, exact]), { identifier: "save" })).toMatchObject({
      width: 0.4,
    });
    expect(selectorToFrame(screen([suffix]), { identifier: "save" })).toMatchObject({
      width: 0.02,
    });
  });

  it("grades an exact identifier at the LITERAL tier, not the folded one", () => {
    // An exact identifier grades two points, not one. As in the regex case,
    // only those two points keep the larger node with the weaker role ahead.
    const exactId: DescribeNode = {
      ...cta,
      identifier: "save", // exact, grade 2
      role: `button${NBSP}`, // folded-equal to the selector's role, grade 1
      frame: { x: 0, y: 0.5, width: 0.4, height: 0.08 },
    };
    const suffixId: DescribeNode = {
      ...icon,
      identifier: "com.example.app:id/save", // suffix rule, grade 0
      role: "button", // literal, grade 2
      frame: { x: 0, y: 0, width: 0.02, height: 0.02 },
    };
    const selector = { identifier: "save", role: "button" };
    expect(selectorToFrame(screen([exactId, suffixId]), selector)).toMatchObject({ width: 0.4 });
    expect(selectorToFrame(screen([suffixId, exactId]), selector)).toMatchObject({ width: 0.4 });
  });

  it("keeps ONE literal field below TWO folded ones, which decides the tap centre", () => {
    // The existing grade tests all catch a DEMOTION. Raising EXACT_LITERAL
    // instead survived every one of them, yet it moves what an action targets:
    // at the sum boundary the large container beats the small leaf outright
    // rather than tying with it and losing the smallest-frame tiebreak.
    const WORD_JOINER = "\u2060";
    const container: DescribeNode = {
      role: "gridcell", // matches `cell` as a substring only, so it grades zero
      label: "Settings",
      identifier: "container",
      frame: { x: 0, y: 0, width: 0.9, height: 0.5 },
      children: [],
    };
    const leaf: DescribeNode = {
      role: `ce${ZWSP}ll`, // folds to `cell`
      label: `${WORD_JOINER}Settings`, // folds to `settings`
      identifier: "leaf",
      frame: { x: 0.4, y: 0.2, width: 0.08, height: 0.05 },
      children: [],
    };
    const selector = { text: "Settings", role: "cell" };
    // 2 for the container's one literal field, 1 + 1 for the leaf's two folded
    // ones: a tie, which the smallest frame then settles.
    expect(selectorToFrame(screen([container, leaf]), selector)).toMatchObject({
      width: 0.08,
    });
    expect(selectorToFrame(screen([leaf, container]), selector)).toMatchObject({
      width: 0.08,
    });
  });

  it("grades a literal role above one only the fold equates", () => {
    // `role` is a folded substring test, so both roles match and only the grade
    // separates them. The literal node is again the larger one.
    const literalRole: DescribeNode = {
      ...cta,
      role: "button",
      identifier: "a",
      frame: { x: 0, y: 0.5, width: 0.4, height: 0.08 },
    };
    const foldedRole: DescribeNode = {
      ...icon,
      role: `button${NBSP}`,
      identifier: "b",
      frame: { x: 0, y: 0, width: 0.02, height: 0.02 },
    };
    expect(selectorToFrame(screen([literalRole, foldedRole]), { role: "button" })).toMatchObject({
      width: 0.4,
    });
    expect(selectorToFrame(screen([foldedRole, literalRole]), { role: "button" })).toMatchObject({
      width: 0.4,
    });
  });
});

describe("end-to-end: a plain selector matches a bidi-wrapped label through findAll", () => {
  // The cases above test the comparators alone. This one tests that the fold
  // reaches findAll and evaluateCondition, for a label in an LRE ... PDF wrapper.
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

describe("the fold cache holds a whole worst-case tree", () => {
  it("does not clear before one tree's labels are in it", () => {
    // The file bounds a tree at 12k nodes, and includesCI folds a label and a
    // value for each node, so one findAll inserts up to 24k keys.
    const KEYS = 24_000;
    for (let i = 0; i < KEYS; i++) foldText(`Row label number ${i}`);
    expect(uiTreeMatchInternals.foldCacheSize()).toBeGreaterThanOrEqual(KEYS);
  });
});

describe("the character sets are pinned member by member, not by a representative", () => {
  // Each case below pins one member of a set, and not a representative.

  it("strips an INTERIOR U+FEFF, which the whitespace collapse cannot rescue", () => {
    // The trim removes a leading U+FEFF whatever INVISIBLE says, because JS
    // `\s` matches it. Only an interior one tests the membership.
    expect(foldText(`a${BOM}b`)).toBe("ab");
    expect(equalsCI(`Save${BOM}Changes`, "SaveChanges")).toBe(true);
  });

  it("folds U+200E LRM, not just the embeddings either side of it", () => {
    expect(equalsCI("a‎b", "ab")).toBe(true);
    expect(foldText("Total:‎ 42")).toBe("total: 42");
  });

  it("counts U+202B RLE as bidi-sensitive, so the LTR half of a pair stays", () => {
    // RLE is not in the LTR set, so it survives either way. Its membership of
    // BIDI_SENSITIVE decides whether the PDF beside it folds.
    const RLE = "‫";
    const PDF = "‬";
    expect(equalsCI(`${RLE}abc${PDF}`, `${RLE}abc`)).toBe(false);
    expect(equalsCI(`‮abc${PDF}`, "‮abc")).toBe(false);
    expect(equalsCI(`⁧abc⁩`, "⁧abc")).toBe(false);
  });

  it("treats the emoji TAG characters as sequence-building, not as noise", () => {
    // U+E0020-U+E007F build a subdivision flag: U+1F3F4 plus five tag letters
    // and a terminator is one glyph, so a broken tag sequence is visible.
    const ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(confusableTextNote(ENGLAND, "\u{1F3F4}")).toBeUndefined();
    expect(foldText(ENGLAND)).not.toBe(foldText("\u{1F3F4}"));
  });

  it("spells out EVERY directional control the fold keeps, not only RLO", () => {
    // The RTL-imposing controls always survive the fold, so they always reorder
    // the rest of the message and are always named.
    for (const ch of ["؜", "‏", "‫", "‮", "⁧"]) {
      const cp = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(quoteScreenText(`a${ch}b`), cp).toBe(`a<${cp}>b`);
    }
    // The LTR wrappers survive it only beside content the bidi algorithm can
    // reorder. There they are named too.
    for (const ch of ["‎", "‪", "‬", "‭", "⁦", "⁨", "⁩"]) {
      const cp = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(quoteScreenText(`شارع${ch}b`), cp).toBe(`شارع<${cp}>b`);
    }
    expect(quoteScreenText("Add more languages…")).toBe("Add more languages…");
  });

  it("names a control character rather than putting a raw byte in the reply", () => {
    // Cc is not Default_Ignorable_Code_Point, so DEL and the C0 controls fell
    // outside every question here - and the quote passed them through into the
    // tool's JSON and the log line beside it. A copy-paste out of a log or a
    // PDF is the usual source, and DEL is legal in HTML text.
    const DEL = "\u007F";
    const NUL = "\u0000";
    expect(quoteScreenText(`Sign${DEL} in`)).toBe("Sign<U+007F> in");
    expect(quoteScreenText(`Save${NUL} file`)).toBe("Save<U+0000> file");
    expect(quoteScreenText("Save\u001B[0m")).toBe("Save<U+001B>[0m");
    // The whitespace members fold to a space or a break, so they stay as they
    // are: naming one would print ASCII the comparison does not want back.
    expect(quoteScreenText("a\tb\nc")).toBe("a\tb\nc");
  });

  it("names a control character in the codepoint note as well", () => {
    const DEL = "\u007F";
    expect(equalsCI(`Sign${DEL} in`, "sign in")).toBe(false);
    const note = confusableTextNote(`Sign${DEL} in`, "sign in")!;
    expect(note).toContain("U+007F");
    expect(note).toContain("invisible characters");
    // And it stays silent when the control is not the only thing in the way.
    expect(confusableTextNote(`Sign${DEL}in`, "sign in")).toBeUndefined();
  });

  it("DROPS an LTR wrapper the fold strips, rather than naming it", () => {
    // Naming it printed eight characters of ASCII the screen does not draw, one
    // line above "copy the text exactly as it is quoted here" — and copying
    // the named form missed a second time.
    expect(quoteScreenText("‪Add more…‬")).toBe("Add more…");
    expect(includesCI("‪Add more…‬", quoteScreenText("‪Add more…‬"))).toBe(true);
    expect(quoteScreenText("‪Hubert Gancarczyk‬")).toBe("Hubert Gancarczyk");
  });

  it("never re-runs the author's pattern, which is what makes the note explosive", () => {
    // When an ignorable blocks an ANCHORED pattern the real comparison dies in
    // O(1) — the engine never enters the quantifier — while the same pattern on
    // the stripped label backtracks. Node's engine is not interruptible and the
    // server is single-threaded, so nothing could stop it. Measured before this
    // guard: 0.015 ms for the comparison, 1,005 ms for the note.
    const BOMB = "^(A+)+b$";
    const label = `${ZWSP}${"A".repeat(30)}`;
    expect(textMatches(label, BOMB, "matches")).toBe(false);
    const started = performance.now();
    const note = ignorableTextNote(label, BOMB);
    expect(performance.now() - started).toBeLessThan(50);
    expect(note).toContain("U+200B");
  });

  it("stays silent when the pattern already spells every ignorable out", () => {
    expect(ignorableTextNote(`a${ZWSP}b`, `a${ZWSP}c`)).toBeUndefined();
    expect(ignorableTextNote(`a${ZWSP}b`, "a.c")).toContain("U+200B");
    expect(ignorableTextNote("plain text", "^plain$")).toBeUndefined();
  });

  it("keeps compatibilityVariantIn silent when the needle genuinely matches", () => {
    // The includesCI guard keeps the note off a label the selector matches.
    expect(compatibilityVariantIn("Add more languages…", "more")).toBe(false);
    expect(compatibilityVariantIn("Add more languages…", "languages")).toBe(false);
    expect(compatibilityVariantIn("Add more languages…", "languages...")).toBe(true);
  });
});
