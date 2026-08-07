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
  selectorToFrame,
  textMatches,
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
    expect(foldText("a⁠b")).toBe("ab"); // word joiner
    expect(foldText("a⁤b")).toBe("ab"); // invisible plus
    expect(foldText("a⁯b")).toBe("ab"); // deprecated format control
  });

  it("keeps a soft hyphen, which PAINTS at a line break", () => {
    // Invisible only while the line does not break there. When it does, the
    // screen reads "kraft-", so folding it onto the unhyphenated spelling
    // asserts text the app does not display.
    expect(foldText(`so${SOFT_HYPHEN}ft`)).not.toBe("soft");
    expect(equalsCI(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toBe(false);
  });

  it("keeps U+180E, which suppresses Arabic cursive joining as ZWNJ does", () => {
    // Unicode 6.3 reclassified it from a space to a zero-width format control,
    // which makes it LOOK inert; between two Arabic letters it breaks the
    // connected run in two, exactly as U+200C does.
    expect(foldText("a᠎b")).not.toBe("ab");
    expect(equalsCI("ب᠎ب", "بب")).toBe(false);
  });

  it("composes a grapheme even when an invisible sat between base and combining mark", () => {
    // NFC must run AFTER invisibles are stripped: a ZWSP wedged between "a" and
    // a combining acute would otherwise block composition and leave a decomposed
    // grapheme that no longer equals its precomposed, identically-rendered twin.
    expect(foldText("a​́")).toBe(foldText("á"));
    expect(foldText("a​́")).toBe("á");
  });

  it("composes AFTER the case fold, for letters whose precomposed form is lowercase-only", () => {
    // `toLowerCase` is not NFC-preserving. U+01F0 (ǰ) has no uppercase
    // precomposed twin, so NFC leaves "J̌" decomposed and lowercasing it yields
    // a decomposed sequence, while the already-lowercase spelling composes.
    // Normalizing before the case fold therefore left two identically-rendered
    // spellings unequal — the inverse of what folding promises.
    const UPPER_DECOMPOSED = "J̌anko"; // J + combining caron
    const LOWER_PRECOMPOSED = "ǰanko"; // ǰ
    expect(foldText(UPPER_DECOMPOSED)).toBe(foldText(LOWER_PRECOMPOSED));
    expect(equalsCI(UPPER_DECOMPOSED, LOWER_PRECOMPOSED)).toBe(true);
    expect(includesCI(`say ${UPPER_DECOMPOSED} now`, LOWER_PRECOMPOSED)).toBe(true);
    // Same shape, different block: U+1E96 (ẖ) is likewise lowercase-only.
    expect(foldText("H̱i")).toBe(foldText("ẖi"));
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
    expect(foldText("Total:\t42")).toBe("total: 42");
  });

  it("keeps a LINE BREAK, which no number of spaces renders as", () => {
    // The whitespace collapse is the horizontal kind only. A soft hyphen is
    // kept for a hyphen it MIGHT paint; `\n` moves the glyphs after it every
    // time, so folding it let `equals: "Sign in"` pass against a label the
    // screen renders on two lines — and nothing downstream catches that,
    // because the fold having equated them leaves confusableTextNote no
    // difference to name.
    expect(foldText("Sign\nin")).toBe("sign\nin");
    expect(equalsCI("Sign\nin", "Sign in")).toBe(false);
    expect(confusableTextNote("Sign\nin", "Sign in")).toBeUndefined();
    expect(includesCI("Line one\nLine two", "one Line")).toBe(false);
    // A tab is horizontal, so it still folds.
    expect(equalsCI("a\tb", "a b")).toBe(true);
    // As does U+2028 LINE SEPARATOR. U+0085 NEXT LINE gets there by a different
    // route — JS `\s` does not match it, so it is never collapsed at all — but
    // lands on the same answer.
    expect(equalsCI("Sign\u2028in", "Sign in")).toBe(false);
    expect(equalsCI("Sign\u0085in", "Sign in")).toBe(false);
  });

  it("still collapses a break run to ONE newline, the spaces around it included", () => {
    // CRLF is one break, not two, and the incidental indentation either side of
    // a break is as invisible as a doubled space is.
    expect(foldText("Line one\r\nLine two")).toBe(foldText("Line one\nLine two"));
    expect(foldText("Line one \n  Line two")).toBe("line one\nline two");
  });

  it("counts only an INTERIOR break, so outer whitespace stays a space", () => {
    // A break at the label's edge separates no glyph from another, and foldText
    // trims it away regardless — so the untrimmed foldLoose must not promote it
    // either, or a `contains` needle's boundary space stops matching a label
    // that happens to end in a newline.
    expect(foldText("\nSign in\n")).toBe("sign in");
    expect(includesCI("  Save   Changes \n", "Changes ")).toBe(true);
    expect(equalsCI("Sign in\n", "Sign in")).toBe(true);
  });

  it("keeps COMPATIBILITY variants distinct — the eye can see those", () => {
    // NFKC would fold every one of these onto plain ASCII, which made a
    // blackletter display name compare equal to the account it imitates.
    // Asserted POSITIVELY as well as negatively: a no-op foldText would satisfy
    // every `not.toBe` here and pin nothing at all.
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

  it("keeps folding correctly once the cache has been cleared at its cap", () => {
    // The cache is a plain size cap: at 4096 entries it is blown away wholesale
    // and refilled. Nothing observed that the clear leaves results intact.
    const probe = `Amount, PLN${NBSP}42.00`;
    const before = foldText(probe);
    for (let i = 0; i < 4200; i++) foldText(`filler-${i}`);
    expect(foldText(probe)).toBe(before);
    expect(equalsCI(probe, "Amount, PLN 42.00")).toBe(true);
    // And a bidi-sensitive string still takes the conditional path afterwards.
    expect(equalsCI("5‏-3", "5-3")).toBe(false);
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
    // The standard low-tech word boundary: `contains: "Taps: 3"` is also
    // satisfied by "Taps: 30", so an author writes a trailing space. Folding
    // trimmed BOTH sides and threw that constraint away.
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
      // Including across the fold's own substitutions.
      expect(includesCI(`Taps:${NBSP}3${NBSP}times`, "Taps: 3 ")).toBe(true);
    });

    it("still ignores the label's own incidental outer whitespace", () => {
      expect(includesCI("  Save   Changes \n", "Save Changes")).toBe(true);
      // ...and a needle whose boundary sits at the label's own edge.
      expect(includesCI("  Save   Changes \n", "Changes ")).toBe(true);
    });

    it("keeps trimming an EQUALS comparison, where outer space is noise", () => {
      expect(equalsCI("  Save   Changes \n", "Save Changes")).toBe(true);
      expect(foldText("  Save   Changes \n")).toBe("save changes");
    });

    it("still refuses a needle that is nothing BUT whitespace", () => {
      // Loosely folded, " " is not empty — without the trimmed emptiness gate
      // it would match every label containing a space.
      expect(includesCI("Save Changes", " ")).toBe(false);
      expect(includesCI("Save Changes", "\t\n ")).toBe(false);
    });
  });

  it("never folds a `matches` (regex) comparison — a pattern carries its precision", () => {
    // Only the regex exemption from the NOTES was covered; its exemption from
    // FOLDING was not, and that is the load-bearing half.
    expect(textMatches(`PLN${NBSP}42`, "PLN 42", "matches")).toBe(false);
    expect(textMatches(`PLN${NBSP}42`, "PLN 42", "contains")).toBe(true);
    expect(textMatches("‪@bsky.app‬", "^@bsky\\.app$", "matches")).toBe(false);
    expect(textMatches("@bsky.app", "^@bsky\\.app$", "matches")).toBe(true);
    // Case too: the literal modes fold it, `matches` does not.
    expect(textMatches("HOME", "^Home$", "matches")).toBe(false);
    expect(textMatches("HOME", "Home", "equals")).toBe(true);
  });

  it("does NOT fold identifiers — a machine key is not read off a screen", () => {
    // Folding is justified by what the eye cannot distinguish; an identifier is
    // never rendered, so two keys that differ by a character are two keys.
    expect(identifierMatches(`submit${ZWSP}`, "submit")).toBe(false);
    expect(identifierMatches("com.example.app:id/submit", `sub${ZWSP}mit`)).toBe(false);
    // Merging distinct testids is the concrete harm.
    expect(identifierMatches("row:id/save ", "row:id/save")).toBe(false);
    // Case-insensitive exact and the unqualified resource-id form still work.
    expect(identifierMatches("Submit", "submit")).toBe(true);
    expect(identifierMatches("com.example.app:id/submit", "submit")).toBe(true);
    // Substring capture is still refused.
    expect(identifierMatches("autosave-banner", "save")).toBe(false);
  });

  it("resolves the `:id/` suffix path exactly, including its refusals", () => {
    // The unqualified-name branch, which no test reached with anything but a
    // clean input.
    expect(identifierMatches("com.example.app:id/save-button", "save-button")).toBe(true);
    expect(identifierMatches("com.example.app:id/Save-Button", "save-button")).toBe(true);
    // A partial tail must not satisfy it — `:id/` anchors the whole name.
    expect(identifierMatches("com.example.app:id/save-button", "button")).toBe(false);
    // Nor may an invisible in the actual id be folded away to make it fit.
    expect(identifierMatches(`com.example.app:id/save${ZWSP}-button`, "save-button")).toBe(false);
    // A bare `:id/` names nothing and must not match every resource-id.
    expect(identifierMatches("com.example.app:id/save-button", " ")).toBe(false);
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
    // LRO and FSI resolve to "lay this out left to right" over LTR content too.
    expect(equalsCI("‭@bsky.app‬", "@bsky.app")).toBe(true);
    expect(equalsCI("⁨@bsky.app⁩", "@bsky.app")).toBe(true);
  });

  it("does not swallow the narrow no-break space next to that range", () => {
    // U+202F sits one codepoint past the embeddings; it is a SPACE, not a
    // formatting control, and must fold to " " rather than vanish.
    expect(foldText(`a${NARROW_NBSP}b`)).toBe("a b");
  });

  // The other half of the rule, and the reason the LTR set is conditional: a
  // control that imposes a RIGHT-to-left order rewrites what the screen shows,
  // in plain ASCII under dir="ltr". Every string below was rendered in Chromium
  // and photographed; the comment records what it actually reads as.
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
      // The classic spoof: what is on screen is `reportexe.txt`.
      expect(equalsCI(`report${RLO}txt.exe`, "reporttxt.exe")).toBe(false);
      expect(includesCI(`report${RLO}txt.exe`, "reporttxt.exe")).toBe(false);
    });

    it("leaves a balanced RTL wrapper, which renders reversed", () => {
      expect(equalsCI(`${RLO}abc${PDF}`, "abc")).toBe(false); // renders `cba`
      expect(equalsCI(`${RLE}abc${PDF}`, "abc")).toBe(false);
      expect(equalsCI(`${RLI}abc${PDI}`, "abc")).toBe(false);
    });

    it("stops folding the LTR controls too once the string carries RTL text", () => {
      // An LRE/PDF wrapper around RTL content is not inert — it forces an LTR
      // base direction the content would not otherwise have, so the words
      // render in a different order than the plain spelling does.
      expect(equalsCI(`${LRE}عمر Smith 2024${PDF}`, "عمر Smith 2024")).toBe(false);
      expect(equalsCI(`${LRI}שלום${PDI}`, "שלום")).toBe(false);
      // Folding half of a directional pair would rewrite the string without
      // rewriting what it renders as, so a PDF next to an RLE stays put.
      expect(equalsCI(`${RLE}abc${PDF}def`, "abcdef")).toBe(false);
    });

    it("decides the LTR strip once per COMPARISON, so a copied needle stays a substring", () => {
      // The strip is conditional on the string being folded, and that is not
      // monotonic under substring: a label carrying one RTL word keeps its
      // wrappers, while a Latin-only fragment copied out of that same label
      // does not — so the identical wrappers were stripped from the needle
      // only, and a needle taken character-for-character off the screen no
      // longer matched the screen.
      const HEB = "שלום";
      const label = `${LRE}@alice${PDF} ${LRE}@bob${PDF} ${HEB}`;
      const needle = `${LRE}@alice${PDF} ${LRE}@bob${PDF}`;
      expect(label.includes(needle)).toBe(true); // a literal substring
      expect(includesCI(label, needle)).toBe(true);
      // Control: the same needle against a label with no RTL word at all. Here
      // both sides strip, and it matched before this rule too.
      expect(includesCI(`${LRE}@alice${PDF} ${LRE}@bob${PDF} hello`, needle)).toBe(true);
      // The pair rule keeps the controls when EITHER side is sensitive, so it
      // can only ever fold less — the wrapper around RTL text still does not
      // equal the bare spelling.
      expect(equalsCI(`${LRE}${HEB}${PDF}`, HEB)).toBe(false);
    });

    it("still folds an LTR wrapper around text that merely LOOKS exotic", () => {
      // No strong-RTL character anywhere, so the wrapper is provably inert and
      // the common Bluesky case keeps working.
      expect(equalsCI(`${LRE}Ελένη Παπαδοπούλου${PDF}`, "Ελένη Παπαδοπούλου")).toBe(true);
      expect(equalsCI(`${LRE}日本語のなまえ${PDF}`, "日本語のなまえ")).toBe(true);
    });
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
  const CGJ = "͏"; // U+034F COMBINING GRAPHEME JOINER

  it("names the differing codepoints when the strings only look equal", () => {
    const note = confusableTextNote(`PLN 42${CGJ}`, "PLN 42")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+034F");
  });

  it("catches U+034F, which is Mn and so escaped a category-Cf test", () => {
    // Genuinely zero-width and unpainted, deliberately NOT folded (it blocks
    // canonical reordering), and category Mn — so the old Cf-keyed note stayed
    // silent and reproduced the exact unexplainable message the note exists to
    // remove: two identical-looking strings, quoted, declared unequal.
    expect(equalsCI(`Save${CGJ}`, "Save")).toBe(false);
    expect(confusableTextNote(`Save${CGJ}`, "Save")).toContain("U+034F");
  });

  it("stays silent for a prepended concatenation mark, which is NOT ignorable", () => {
    // U+110BD KAITHI NUMBER SIGN is category Cf but changes how the digits
    // after it render, so calling it invisible would be a false explanation.
    expect(confusableTextNote("PLN 42\u{110BD}", "PLN 42")).toBeUndefined();
  });

  it("does not call a ZWJ emoji sequence an invisible difference", () => {
    // The module's flagship counter-example. The fold correctly refuses to
    // equate a trans flag (ONE glyph) with the two separate glyphs of a broken
    // sequence — and then this note called that difference invisible noise, so
    // an author who believed it would "fix" the flow by copying the rendered
    // text and mask a real rendering regression forever.
    const FLAG = "\u{1F3F3}️‍⚧️";
    const BROKEN = "\u{1F3F3}️⚧️";
    expect(confusableTextNote(FLAG, BROKEN)).toBeUndefined();
    // Nor a variation selector or a ZWNJ, for the same reason.
    expect(confusableTextNote(`ok${VARIATION_SELECTOR_16}`, "ok")).toBeUndefined();
    expect(confusableTextNote("a‌b", "ab")).toBeUndefined();
  });

  it("says a directional difference REORDERS rather than calling it invisible", () => {
    // U+200F draws nothing, so "invisible" is true of the character and false
    // of the string: `5<RLM>-3` renders `53-`. Telling an author to copy what
    // the app renders would be the same trap the emoji case sets.
    const note = confusableTextNote("5‏-3", "5-3")!;
    expect(note).toContain("REORDERS");
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("U+200F");
  });

  it("says a soft hyphen is a RENDERING difference rather than calling it invisible", () => {
    // SHY is Default_Ignorable, so it reached the note as ordinary inert noise
    // — and the note then told the exact false story the fold keeps it to
    // prevent: `kraft<SHY>fahrzeug` paints `kraft-` at a line break, so an
    // author who "copies what the app renders" masks that permanently.
    expect(equalsCI(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")).toBe(false);
    const note = confusableTextNote(`kraft${SOFT_HYPHEN}fahrzeug`, "kraftfahrzeug")!;
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("changes what IS drawn");
    expect(note).toContain("U+00AD");
  });

  it("says the same of U+180E, which does ZWNJ's job", () => {
    // ZWNJ is dropped from the note outright; U+180E breaks the same Arabic
    // cursive run for the same reason, so it must not be described as noise
    // just because it is not in the sequence-building set.
    expect(equalsCI("ب᠎ب", "بب")).toBe(false);
    const note = confusableTextNote("ب᠎ب", "بب")!;
    expect(note).not.toContain("differ only in invisible characters");
    expect(note).toContain("changes what IS drawn");
    expect(note).toContain("U+180E");
  });

  it("lets the reordering lead win a difference that is both", () => {
    // A mixed difference gets the sharper claim; what matters is that neither
    // branch calls it invisible.
    const note = confusableTextNote(`5‏-3${SOFT_HYPHEN}`, "5-3")!;
    expect(note).toContain("REORDERS");
    expect(note).not.toContain("differ only in invisible characters");
  });

  it("still calls a shared soft hyphen's OTHER difference invisible", () => {
    // Both sides carry the SHY, so it is not what differs — the ZWSP is.
    const note = confusableTextNote(
      `kraft${SOFT_HYPHEN}fahr${ZWSP}zeug`,
      `kraft${SOFT_HYPHEN}fahrzeug`
    )!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+200B");
  });

  it("still calls a shared directional wrapper's OTHER difference invisible", () => {
    // Both sides carry the same LRE/PDF pair, so the directional characters are
    // not what differs — the ZWSP is, and that one really is inert.
    const note = confusableTextNote("‪Save​‬", "‪Save‬")!;
    expect(note).toContain("differ only in invisible characters");
    expect(note).toContain("U+200B");
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

describe("ranking prefers the literal spelling over one only the fold equates", () => {
  // Folding is what LOCATES an element an author cannot otherwise name. But
  // once two elements both match, ranking has to keep telling them apart, or
  // the "smallest frame wins" tiebreak elects the decorative one: a 28x28
  // icon-only button labelled "Sign<NBSP>in" beside the 420x70 button whose
  // text is literally "Sign in". `tap` fired the icon, and reported pass.
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
    // Order-independent: it is the grade that decides, not which came first.
    expect(selectorToFrame(screen([cta, icon]), { text: "Sign in" })).toMatchObject({
      width: 0.35,
    });
  });

  it("still resolves a folded-only match when it is the ONLY one", () => {
    // The fold has not been undone — with no literal spelling on screen, the
    // NBSP label is still found, which is the whole point of folding.
    expect(selectorToFrame(screen([icon]), { text: "Sign in" })).toMatchObject({
      width: 0.023,
    });
  });

  it("grades identifier and role the same way", () => {
    const folded: DescribeNode = {
      ...icon,
      identifier: `save${ZWSP}`,
      frame: { x: 0, y: 0, width: 0.02, height: 0.02 },
    };
    const literal: DescribeNode = {
      ...cta,
      identifier: "save",
      frame: { x: 0, y: 0.5, width: 0.4, height: 0.08 },
    };
    expect(selectorToFrame(screen([folded, literal]), { identifier: "save" })).toMatchObject({
      width: 0.4,
    });
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
