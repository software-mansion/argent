import { z } from "zod";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { describeChromium } from "../tools/describe/platforms/chromium";
import { describeVega } from "../tools/describe/platforms/vega";
import { chromiumCdpRef, type ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Shared accessibility/DOM-tree matching, extracted from `await-ui-element` so
 * the flow directives (`tap`, `type`, `assert`) and the recorder's reverse
 * lookup consume the same selector semantics the wait engine uses.
 */

// A selector locates a node in the tree returned by `describe`. Every provided
// field must match (logical AND). `text` and `role` match as case-insensitive
// substrings so callers don't need the exact label; `identifier` matches
// exactly (or as the unqualified name of an Android resource-id) — see
// `identifierMatches`.
/**
 * Strict validation for the fields shared by every selector representation.
 * Kept separate from the non-empty selector refinement so flow-only selector
 * forms can replace `text` with another validated text constraint while still
 * reusing the canonical identifier/role validation.
 */
/**
 * True when `text` contains at least one visibly-rendered, font-independent
 * character. Icon fonts expose their glyphs as Private Use Area code points
 * (a tab-bar icon's label can be U+E163 — an icon, not text) and zero-width /
 * format characters render as nothing: a text constraint made only of those
 * displays as EMPTY in flow YAML, is meaningless outside the app's private
 * font, and at replay matches an element no reader of the flow can predict.
 * Strips Cf (format: zero-width space/joiners, BOM), Co (private use) and
 * Cc (controls), then whitespace; visible = anything left.
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{Cf}\p{Co}\p{Cc}]/gu, "").trim().length > 0;
}

export const selectorFieldsSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine(hasVisibleText, {
        message:
          "text must contain at least one visible character (icon-font/private-use and " +
          "zero-width characters render as nothing) — select by identifier or role instead",
      })
      .optional()
      .describe("Case-insensitive substring of the element's visible label or value."),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The element's identifier (accessibilityIdentifier / resource-id / testid), matched case-insensitively as the exact identifier or the unqualified resource-id name ('submit' matches 'com.example.app:id/submit')."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's role (e.g. AXButton, button, TextView)."
      ),
  })
  .strict();

export const selectorSchema = selectorFieldsSchema.refine(
  (s) => Boolean(s.text || s.identifier || s.role),
  {
    message: "selector needs at least one of text, identifier, or role",
  }
);

export type Selector = z.infer<typeof selectorSchema> & {
  /**
   * Flow-only regex text locator (`{ text: { matches: '<pattern>' } }` in flow
   * YAML): a JS regular expression tested — unanchored and case-sensitive,
   * the same doctrine as the `text` condition's `matches` — against the
   * node's OWN label/value, deliberately not the hoisted `subtreeText`:
   * subtree matching would make every unshielded ancestor of a text leaf
   * match too, degrading the exact-beats-substring ranking actions rely on.
   * Aggregate checks stay the `text` condition's job (`{ in, matches }`).
   * A type-level extension, not a schema field, so the `await-ui-element`
   * tool surface doesn't grow (the same boundary `TextMatchMode.matches`
   * draws below).
   */
  textMatches?: string;
  /**
   * Flow-only container scope (`{ text: "Delete", within: { id: "card" } }` in
   * flow YAML): the node must additionally sit INSIDE a distinct element
   * matching this selector — its frame contained in the container's frame
   * (small tolerance for sub-pixel overhang). Deliberately geometric, not
   * tree-ancestry: every flow adapter flattens its platform tree into leaves
   * under one synthetic root (see `flow-tree-flatten`), so ancestry does not
   * survive to replay — and visual containment is what "the button inside the
   * card" means to a flow author anyway (the same frame-based reading of
   * "within" the scroll-to directive's container anchor uses). Scopes chain
   * outward (`a within b within c` reads "a inside b inside c", each
   * container's frame inside the next). Resolved by {@link findAll}, which
   * sees the whole tree; {@link matchNode} is a single-node predicate and
   * evaluates own fields only. A type-level extension, not a schema field,
   * for the same reason as `textMatches`.
   */
  within?: Selector;
  /**
   * Flow-only general-sibling scope (`{ role: Switch, after: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `~` combinator: the node must FOLLOW a distinct
   * element matching this selector in reading order (see {@link frameAfter}:
   * strictly below the anchor, or sharing its row band and entirely to its
   * right). Geometric for the same reason `within` is — flow trees flatten, so
   * every element is a sibling and only frames survive to replay. Resolved by
   * {@link findAll}; a type-level extension, not a schema field.
   */
  after?: Selector;
  /**
   * Flow-only adjacent-sibling scope (`{ role: Switch, next: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `+` combinator: like {@link after}, but only the
   * NEAREST following match is kept, per anchor (CSS `A + B` is likewise the
   * union over every A of the one sibling right after it). This is the "the
   * control belonging to this row's label" locator. Resolved by
   * {@link findAll}; a type-level extension, not a schema field.
   */
  next?: Selector;
};

export type WaitCondition = "exists" | "visible" | "hidden" | "text";

// How a `text` condition compares the located element's text to the expected
// string: `contains` (default) is a case-insensitive substring; `equals` is a
// case-insensitive full-string match (so "1" no longer satisfies "10"). Both
// are offered so a caller can assert "shows this somewhere" or "shows exactly
// this" interchangeably. `matches` treats the expected string as a JS regular
// expression tested unanchored against the text (the `contains` analog —
// anchor with ^…$ for the `equals` analog) for dynamic content that neither
// literal mode can pin (counters, prices, dates). Unlike the literal modes it
// is CASE-SENSITIVE — a regex carries its semantics in the pattern, and
// forcing `i` would betray `\d{2}`-style precision. Flow directives only; the
// await-ui-element tool's schema deliberately stays contains/equals.
export type TextMatchMode = "contains" | "equals" | "matches";

// ── Tree matching ──────────────────────────────────────────────────────────

export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// Text used to evaluate a `text` condition (and quoted in its failure
// messages). Prefers `subtreeText` — the text hoisted from descendants by the
// flow adapters — so a `text` check against a testID container reads the text
// it visibly wraps (e.g. a counter whose number is a child node), not the
// container's own (empty) label. Falls back to the node's own text when no
// descendant text was hoisted (every non-flow tree, and any leaf that already
// carries its own text). `evaluateCondition` additionally accepts a match on
// the node's own text — hoisting is additive, see the comment there. Selector
// matching stays on `nodeText` so `tap`/`{ text }` targeting is unaffected.
export function assertText(node: DescribeNode): string {
  return node.subtreeText ?? nodeText(node);
}

// ── Text folding ───────────────────────────────────────────────────────────
//
// UI text is not the text an author types. A currency label renders with a
// non-breaking space, a layout wraps a user-supplied name in bidi isolates, a
// soft hyphen or ZWSP survives a copy-paste. All of them survive
// `toLowerCase()`, so the comparison fails against two strings that are
// character-for-character identical on screen and in the failure message. That
// is unexplainable in CI, and it cost whole 15-second timeouts per attempt.
//
// So every literal comparison folds both sides first. Folding only ever
// removes distinctions the eye cannot see; `matches` (regex) is deliberately
// exempt, because a pattern carries its own precision.
//
// "Invisible" is NOT the same as "renders identically", and that gap is the
// whole design of the three blocks below. Zero advance width is universal
// across this area — measured per character with Range.getBoundingClientRect
// in Chromium, every one of these controls is 0 px wide — so a width test
// alone calls the dangerous ones safe. What decides is whether removing the
// character can change the GLYPHS drawn or their ORDER:
//
//   - A bidi control reorders the text around it, in plain ASCII under
//     dir="ltr", with no RTL content anywhere. "5" + U+200F + "-3" renders
//     `53-`, and U+202E turns `report<RLO>txt.exe` into `reportexe.txt`.
//     Folding those let an assertion pass against a screen that plainly reads
//     something else — the silently-wrong green this module rates worse than a
//     flake, arriving through the fold itself.
//   - A soft hyphen paints a real hyphen when the line breaks there.
//   - U+180E suppresses Arabic cursive joining exactly as ZWNJ does.
//
// So the set is split three ways: always safe, safe only while the string has
// no bidi content, and never.

/** Space-like codepoints that are not U+0020. NBSP, narrow NBSP, ideographic, en/em quad, etc. */
const SPACE_LIKE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;

/**
 * Invisible formatting that cannot change a glyph or its position in ANY
 * context: ZWSP, word joiner, the invisible math operators, the deprecated
 * format controls, BOM. The most any of these does is offer or forbid a
 * line-break opportunity, which moves where a line wraps but never what
 * characters are drawn, or in what order.
 *
 * NOT ZWNJ/ZWJ or the variation selectors — the class starts at U+200B and
 * jumps to U+2060 to skip them, because they are load-bearing in sequence (see
 * the DELIBERATELY NOT FOLDED block below). U+2065 is unassigned, so the
 * invisible-operator run stops at U+2064 and resumes at the deprecated
 * controls, U+206A.
 */
const INVISIBLE = /[\u200b\u2060-\u2064\u206a-\u206f\ufeff]/gu;

/**
 * The LTR-forcing directional controls — LRM, LRE, PDF, LRO, LRI, FSI, PDI —
 * folded ONLY when {@link BIDI_SENSITIVE} finds nothing in the string that
 * could give the bidi algorithm a non-trivial order to produce. In a string
 * whose strong characters are all left-to-right, every one of these resolves
 * to "lay this out left to right", which is already what happens, so removing
 * them provably cannot move a glyph.
 *
 * This is what keeps the common real case working. An app that renders
 * user-supplied names wraps every one of them: a census of four Bluesky web
 * screens found 367 U+202A/U+202C pairs and not a single NBSP, and what they
 * wrap is overwhelmingly a plain Latin handle. Those still fold. What no
 * longer folds is the same wrapper around text it actually reorders.
 *
 * Their RTL counterparts are deliberately absent, and live in
 * {@link BIDI_SENSITIVE} instead: RLM, ALM, RLE, RLO and RLI impose a
 * right-to-left order on the neutrals around them even in otherwise-ASCII
 * text, so they are never foldable. A string containing one is also, by that
 * very membership, bidi-sensitive — which is why the LTR controls in it stay
 * too. Folding half of a directional pair would rewrite the string without
 * rewriting what it renders as.
 */
const LTR_BIDI = /[\u200e\u202a\u202c\u202d\u2066\u2068\u2069]/gu;

/**
 * Does this string contain anything that makes the bidi algorithm's output
 * depend on more than logical order — a strong RTL or Arabic-number character,
 * or one of the RTL-imposing controls? Deliberately over-inclusive (whole
 * script blocks, rather than the exact Bidi_Class membership JS regex cannot
 * express): a false positive only means folding less, which is always safe,
 * while a false negative is the defect this exists to prevent.
 *
 * Not global, and only ever used with `.test`, so there is no `lastIndex` to
 * reset between calls.
 */
const BIDI_SENSITIVE =
  /[\u061c\u200f\u202b\u202e\u2067\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

// DELIBERATELY NOT FOLDED, for the same reason NFKC is not used: these are
// invisible ALONE but LOAD-BEARING in sequence, so removing them changes what
// is on screen.
//
// - U+200D ZERO WIDTH JOINER and U+FE00-FE0F VARIATION SELECTORS build emoji
//   sequences. The transgender flag is U+1F3F3 VS16 ZWJ U+26A7 VS16 — ONE
//   glyph. Stripping them folded it onto two separate glyphs, so a `text`
//   check passed against a visibly different display name, and a BROKEN
//   sequence — a real rendering regression — became invisible to every check.
// - U+200C ZERO WIDTH NON-JOINER suppresses ligatures in Arabic, Persian and
//   Indic scripts, where its presence or absence is a spelling difference.
// - U+180E MONGOLIAN VOWEL SEPARATOR does ZWNJ's job: it suppresses Arabic
//   cursive joining (ببببب goes from one connected run at 135 px to two at
//   173 px), so by the criterion above it belongs here beside it — however
//   much its Unicode 6.3 reclassification from a space to a zero-width format
//   control makes it look like a member of the INVISIBLE block.
// - U+00AD SOFT HYPHEN is invisible only while the line does NOT break there.
//   When it does, it paints a real hyphen: `kraft<SHY>fahrzeug` displays
//   `kraft-`, so folding it onto `kraftfahrzeug` asserts text the screen does
//   not show.
// - The RTL directional controls (U+061C, U+200F, U+202B, U+202E, U+2067) and,
//   in any string carrying bidi content, their LTR counterparts too. See
//   {@link LTR_BIDI} and {@link BIDI_SENSITIVE}.

const foldCache = new Map<string, string>();
const FOLD_CACHE_MAX = 4096;

/**
 * The comparable form of a piece of UI text: invisible formatting stripped,
 * NFC-normalized, every space-like codepoint reduced to a plain space, runs of
 * whitespace collapsed, trimmed, lowercased.
 *
 * **NFC, not NFKC.** Canonical normalization only equates spellings that
 * render identically (a precomposed "é" and its decomposed form). COMPATIBILITY
 * normalization goes further and folds away differences the eye reads
 * perfectly well — mathematical alphanumerics, ligatures, full-width forms,
 * superscripts, circled digits. With NFKC a blackletter display name compared
 * EQUAL to its plain-ASCII spelling, so a check could not tell an
 * impersonating account from the real one: a silently-wrong green, which is
 * exactly what this module's doctrine calls worse than a flake. The invariant
 * is that folding only ever removes distinctions the eye cannot see, and NFKC
 * breaks it.
 *
 * The directional half of that invariant is conditional, which is why the
 * strip runs in two passes: {@link INVISIBLE} always, {@link LTR_BIDI} only
 * when the string carries no {@link BIDI_SENSITIVE} content to be reordered.
 */
export function foldText(value: string): string {
  return foldLoose(value).trim();
}

/**
 * {@link foldText} without the trim — leading and trailing whitespace survive
 * as a single space each.
 *
 * A substring test needs this. A boundary space is the standard low-tech word
 * boundary (`contains: "Taps: 3"` is also satisfied by "Taps: 30", so an author
 * writes `"Taps: 3 "`), and trimming BOTH sides silently discarded exactly the
 * constraint they added: `contains "Save "` started matching "Saved
 * successfully", and `contains " OK"` matched "NOTOK". A regex needle is exempt
 * from folding because "a pattern carries its own precision"; a boundary space
 * is the same claim in the literal modes, and gets the same protection.
 *
 * Trimming still belongs on an EQUALS comparison, where a label's incidental
 * outer whitespace is noise rather than a boundary — so {@link foldText} keeps
 * it, and only {@link includesCI} reaches past it.
 */
function foldLoose(value: string): string {
  const hit = foldCache.get(value);
  if (hit !== undefined) return hit;
  // Strip invisibles BEFORE composing: an invisible sitting between a base
  // letter and its combining mark blocks NFC from composing them, so a later
  // strip would leave a decomposed grapheme that no longer equals its
  // precomposed twin. Removing it first lets the NFC pass compose the pair.
  let stripped = value.replace(INVISIBLE, "");
  // The bidi test reads the string as it stands: none of the controls it looks
  // for is in the INVISIBLE class, so all of them survive that first pass.
  if (!BIDI_SENSITIVE.test(stripped)) stripped = stripped.replace(LTR_BIDI, "");
  const folded = stripped
    .normalize("NFC")
    .replace(SPACE_LIKE, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  // Trees are re-read on every poll, so the same strings recur constantly.
  // A plain size cap (rather than an LRU) is enough: the working set is one
  // screen's labels, and blowing it away wholesale costs one refill.
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(value, folded);
  return folded;
}

/**
 * Do these two strings differ ONLY by a compatibility variant — a rendered `…`
 * against three typed dots, a ligature, a fullwidth form?
 *
 * Deliberately not folded away (see {@link foldText}): those glyphs are
 * visibly different, and equating them is how a blackletter display name came
 * to match the account it imitates. But an author who types `...` for a label
 * the app renders with U+2026 gets a selector that matches NOTHING, and a
 * bare "no element matched" gives them no way to see why. This is what turns
 * that miss into an explanation.
 */
export function compatibilityVariantOf(actual: string, expected: string): boolean {
  if (foldText(actual) === foldText(expected)) return false;
  // NFKC is itself NFKD followed by canonical composition, so the leading NFKD
  // is redundant — `s.normalize("NFKD").normalize("NFKC")` equals
  // `s.normalize("NFKC")` for every codepoint.
  const compat = (s: string): string => foldText(s.normalize("NFKC"));
  return compat(actual) === compat(expected);
}

/**
 * Characters that draw no glyph of their own but BUILD one in sequence, so a
 * string that has them does not look like the same string without them: ZWNJ,
 * ZWJ, both variation-selector blocks, and the emoji tag characters. Exactly
 * the set the fold deliberately keeps — see the DELIBERATELY NOT FOLDED block.
 */
const SEQUENCE_BUILDING = /[‌‍︀-️\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

/** The directional controls: no glyph of their own, but they REORDER text. */
const DIRECTIONAL = /[؜‎‏‪-‮⁦-⁩]/u;

/**
 * Every default-ignorable code point EXCEPT the sequence-building ones — the
 * characters whose removal genuinely leaves the string looking the same.
 * `Default_Ignorable_Code_Point` rather than category `Cf`, in both directions:
 * it excludes the prepended concatenation marks (U+0600-0605, U+110BD and kin),
 * which are `Cf` but do affect how the digits after them render, and it
 * includes U+034F COMBINING GRAPHEME JOINER, which is `Mn` and so escaped a
 * `Cf` test entirely despite being exactly the kind of unexplainable invisible
 * this note exists for.
 */
const IGNORABLE_AND_INERT = new RegExp(
  `(?!${SEQUENCE_BUILDING.source})\\p{Default_Ignorable_Code_Point}`,
  "gu"
);

/** Which ignorable characters occur a DIFFERENT number of times in each string? */
function differingIgnorables(actual: string, expected: string): string[] {
  const tally = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const ch of s.match(IGNORABLE_AND_INERT) ?? []) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    return counts;
  };
  const a = tally(actual);
  const b = tally(expected);
  return [...new Set([...a.keys(), ...b.keys()])].filter(
    (ch) => (a.get(ch) ?? 0) !== (b.get(ch) ?? 0)
  );
}

/**
 * A note naming the difference between two strings that LOOK equal but are not.
 *
 * This fires only where the FOLD did not already handle it. Folding-equal
 * strings compare equal, so the check passes and no message is produced at all;
 * the note therefore has to key on a strictly wider notion of "looks the same"
 * than {@link foldText} — here, equality once every INERT default-ignorable is
 * removed. That makes it the safety net for invisible characters the fold's
 * explicit classes do not list, which is precisely the failure that is
 * otherwise unexplainable: two identical-looking strings, quoted side by side,
 * declared unequal.
 *
 * What it must never do is call a REAL rendering difference invisible, because
 * the advice that follows such a note is "copy what the app renders" and an
 * author who takes it masks the regression permanently:
 *
 * - The {@link SEQUENCE_BUILDING} characters are excluded outright. The fold
 *   keeps ZWJ so a trans flag (U+1F3F3 VS16 ZWJ U+26A7 VS16, ONE glyph) cannot
 *   equal the two separate glyphs of a broken sequence — and then this note
 *   described that very difference as invisible noise, so the module's own
 *   flagship counter-example came with advice to defeat it.
 * - A {@link DIRECTIONAL} difference is reported as what it is: those draw no
 *   glyph, but they move the ones around them, so "invisible" would be just as
 *   false a story about a `53-` that was asked to equal `5-3`.
 *
 * Returns undefined when the strings are equal, or differ visibly — the quoted
 * strings already say that.
 */
export function confusableTextNote(actual: string, expected: string): string | undefined {
  if (actual === expected) return undefined;
  // Ignorables ONLY. Lowercasing or NFKC-folding here would call a plain case
  // difference — or a compatibility variant like "ﬁ" vs "fi" — "invisible",
  // which is false: those differ in characters the eye reads perfectly well.
  // The literal comparators already fold both, so a pair differing only that
  // way passes and never reaches this note; a regex comparison is
  // case-sensitive by design and must not be told otherwise.
  const visible = (s: string): string => s.replace(IGNORABLE_AND_INERT, "");
  if (visible(actual) !== visible(expected)) return undefined;
  const codepoints = (s: string): string =>
    Array.from(s)
      .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(" ");
  const lead = differingIgnorables(actual, expected).some((ch) => DIRECTIONAL.test(ch))
    ? "the two strings differ only in directional formatting, which draws nothing itself but " +
      "REORDERS the characters around it, so the screen does not read the way the text does"
    : "the two strings differ only in invisible characters";
  return `${lead} — actual [${codepoints(actual)}] vs expected [${codepoints(expected)}]`;
}

export function includesCI(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  // A needle that folds away to nothing is not a weak constraint, it is NO
  // constraint: `"".includes()` is true of every string, so `{ role: " " }`
  // matched every element on the screen and the check could never fail — the
  // exact defect class the `hidden` evidence gate exists to prevent, arriving
  // through a selector field instead. `text` was already covered by
  // hasVisibleText; `role` and `identifier` were not, so refuse it here where
  // every literal comparison passes through.
  //
  // The emptiness test is the TRIMMED fold, deliberately: a needle of pure
  // whitespace folds loosely to " ", which is not empty and would then match
  // every label containing a space — the very gate this is.
  if (foldText(needle) === "") return false;
  // Both sides UNTRIMMED, so a boundary space in the needle survives to
  // constrain the match. See {@link foldLoose}.
  return foldLoose(haystack).includes(foldLoose(needle));
}

export function equalsCI(actual: string | undefined, expected: string): boolean {
  // Same rule as includesCI/identifierMatches: an expected that folds away to
  // nothing is NO constraint, not an exact one, so it must not equal a textless
  // element. Without this, `equalsCI("", " ")` is true — a `text`/`equals`
  // check whose expected is whitespace- or invisible-only (a bare `" "`, a
  // bidi pair, a ZWSP that survived a copy-paste) passed against every element
  // with no text: the silently-wrong green this module rates worse than a flake.
  const wanted = foldText(expected);
  if (wanted === "") return false;
  return foldText(actual ?? "") === wanted;
}

/**
 * Identifier matching: case-insensitive EXACT match, or the unqualified name of
 * an Android resource-id — `submit` matches `com.example.app:id/submit` — so a
 * caller never needs the package prefix. Deliberately NOT a substring test: an
 * identifier names one element, and substring matching lets a short needle
 * capture an unrelated id (`save` must not match `autosave-banner`), which is
 * how a loose flow selector's identifier-first pass could hijack a tap.
 */
export function identifierMatches(actual: string | undefined, needle: string): boolean {
  if (!actual) return false;
  // Same rule as includesCI: an identifier that folds away to nothing names no
  // element, so it must not match one — neither the blank-identifier nodes that
  // `equalsCI("", "")` would accept, nor every resource-id via a bare `:id/`.
  const wanted = foldText(needle);
  if (wanted === "") return false;
  return equalsCI(actual, needle) || foldText(actual).endsWith(`:id/${wanted}`);
}

/** @internal A narrow seam for verifying regex compilation lifetime in tests. */
export const uiTreeMatchInternals = {
  createRegExp(pattern: string): RegExp {
    return new RegExp(pattern);
  },
};

// Empty/absent text is not a regex haystack, matching includesCI's semantics.
// Keeping that rule here prevents selector, assertion, and ranking paths from
// drifting apart when they reuse a compiled expression.
function regexMatchesNonEmpty(regex: RegExp, actual: string | undefined): boolean {
  if (!actual) return false;
  return regex.test(actual);
}

/** Compare an element's text to the expected string under the chosen mode. */
export function textMatches(
  actual: string | undefined,
  expected: string,
  mode: TextMatchMode
): boolean {
  // The pattern was validated at flow parse time, so construction here cannot
  // throw on a flow's behalf.
  if (mode === "matches") {
    return regexMatchesNonEmpty(uiTreeMatchInternals.createRegExp(expected), actual);
  }
  return mode === "equals" ? equalsCI(actual, expected) : includesCI(actual, expected);
}

/**
 * Does the selector constrain WHICH element it matches, rather than only where
 * to look? False exactly for the universal selector (flow YAML's `any: true`),
 * whose relational scopes are its whole content.
 */
function hasOwnConstraint(selector: Selector): boolean {
  return (
    selector.text !== undefined ||
    selector.textMatches !== undefined ||
    selector.identifier !== undefined ||
    selector.role !== undefined
  );
}

function matchNodeWithRegex(
  node: DescribeNode,
  selector: Selector,
  textRegex: RegExp | undefined
): boolean {
  if (selector.text !== undefined) {
    if (!includesCI(node.label, selector.text) && !includesCI(node.value, selector.text)) {
      return false;
    }
  }
  if (textRegex !== undefined) {
    if (
      !regexMatchesNonEmpty(textRegex, node.label) &&
      !regexMatchesNonEmpty(textRegex, node.value)
    ) {
      return false;
    }
  }
  if (
    selector.identifier !== undefined &&
    !identifierMatches(node.identifier, selector.identifier)
  ) {
    return false;
  }
  if (selector.role !== undefined && !includesCI(node.role, selector.role)) {
    return false;
  }
  return true;
}

function selectorTextRegex(selector: Selector): RegExp | undefined {
  return selector.textMatches === undefined
    ? undefined
    : uiTreeMatchInternals.createRegExp(selector.textMatches);
}

/**
 * Single-node predicate over the selector's OWN fields (text/regex/identifier/
 * role). The relational scopes (`within`/`after`/`next`) need the tree and are
 * resolved by {@link findAll}; they are ignored here by design.
 *
 * A selector with no own fields matches EVERY node — the universal selector
 * (CSS `*`, spelled `any: true` in flow YAML). Nothing can reach here that way
 * by accident: `selectorSchema` requires a field, and the flow parser only
 * lets a field-less selector through behind an explicit `any: true` paired
 * with a relation.
 */
export function matchNode(node: DescribeNode, selector: Selector): boolean {
  return matchNodeWithRegex(node, selector, selectorTextRegex(selector));
}

// Frame-comparison tolerance (normalized units): a hair of overhang — a border,
// a shadow, sub-pixel rounding — must not change what the eye plainly sees.
// `frameWithin` reads it as containment slack (an element overhanging its
// container's edge is still in it); `frameAbove` reads it as the row-band merge
// threshold (two frames whose edges touch within it are still one row, not two).
// Matches the magnitude of the flow runner's edge tolerance (EDGE_EPS in
// flow-actions).
const WITHIN_EPS = 0.005;

/** Is `inner` contained in `outer`, within {@link WITHIN_EPS} per edge? */
function frameWithin(inner: DescribeFrame, outer: DescribeFrame): boolean {
  return (
    inner.x >= outer.x - WITHIN_EPS &&
    inner.y >= outer.y - WITHIN_EPS &&
    inner.x + inner.width <= outer.x + outer.width + WITHIN_EPS &&
    inner.y + inner.height <= outer.y + outer.height + WITHIN_EPS
  );
}

// Resolving a `within` scope asks "does this candidate sit inside SOME distinct
// container?" for every candidate against every container. The naive form scans
// the whole container set per candidate — O(candidates × containers) — which a
// broad container selector (`within: { role: <common role> }`, a form the
// nested slot explicitly allows) drives quadratic on the flattened flow tree
// (bounded per platform — 12k nodes on Android/Chromium, depth-capped on iOS),
// and findAll re-runs on every settle/poll. Above a small container count, index
// the containers in a coarse uniform grid so a candidate only tests the
// containers registered in its own top-left cell. The realistic container shapes
// — scattered role matches, a list of stacked rows, a grid of cards — each land
// only a handful of containers per cell, dropping the scan to near-linear. Only
// a `within` selector ever builds this; an unscoped findAll never reaches it.
// (The one input the grid can't prune is many mutually-overlapping containers
// crammed into one cell — it degrades gracefully back to the naive scan there,
// never worse, since the exact check still short-circuits on the first hit.)
const CONTAINMENT_GRID_N = 16; // cells per axis over the normalized [0,1]² frame
const CONTAINMENT_GRID_MIN = 32; // fewer containers than this: a direct scan wins

// The grid column/row a normalized coordinate falls in, clamped to [0, N): a
// frame can sit a hair off-screen (negative, or ≥ 1), and every such point must
// still map to a real cell.
function gridCell(coord: number): number {
  const c = Math.floor(coord * CONTAINMENT_GRID_N);
  return c < 0 ? 0 : c >= CONTAINMENT_GRID_N ? CONTAINMENT_GRID_N - 1 : c;
}

/**
 * Build a predicate `inside(node)` — true when the node's frame sits inside a
 * DISTINCT container in `containers` (the {@link frameWithin} containment a
 * `within` scope needs). Below {@link CONTAINMENT_GRID_MIN} it scans directly;
 * larger sets are indexed in a coarse grid keyed by top-left cell.
 *
 * A container is registered in every cell its frame covers, PADDED by
 * {@link WITHIN_EPS}: a candidate may overhang a container edge by up to the
 * tolerance, so its top-left corner can land one cell before the container's
 * unpadded coverage — the pad guarantees the corner still hits a registered
 * cell. The grid therefore only PRUNES; the exact `frameWithin` check on the
 * bucket decides, so the padding never admits a false containment.
 */
function containmentTester(containers: DescribeNode[]): (node: DescribeNode) => boolean {
  if (containers.length < CONTAINMENT_GRID_MIN) {
    return (node) => containers.some((c) => c !== node && frameWithin(node.frame, c.frame));
  }
  const cells = new Map<number, DescribeNode[]>();
  for (const c of containers) {
    const f = c.frame;
    const colEnd = gridCell(f.x + f.width + WITHIN_EPS);
    const rowEnd = gridCell(f.y + f.height + WITHIN_EPS);
    for (let row = gridCell(f.y - WITHIN_EPS); row <= rowEnd; row++) {
      for (let col = gridCell(f.x - WITHIN_EPS); col <= colEnd; col++) {
        const key = row * CONTAINMENT_GRID_N + col;
        const bucket = cells.get(key);
        if (bucket) bucket.push(c);
        else cells.set(key, [c]);
      }
    }
  }
  return (node) => {
    const bucket = cells.get(gridCell(node.frame.y) * CONTAINMENT_GRID_N + gridCell(node.frame.x));
    return (
      bucket !== undefined && bucket.some((c) => c !== node && frameWithin(node.frame, c.frame))
    );
  };
}

// ── Reading-order sibling relations (`after` / `next`) ─────────────────────

/**
 * Is `a` entirely above `b` — a's bottom edge at or above b's top, within
 * {@link WITHIN_EPS}? The vertical half of reading order. Two frames for which
 * this fails BOTH ways share a row band (their vertical spans overlap) and are
 * ordered horizontally instead — that band rule is what makes "the switch after
 * the Wi-Fi label" work, since a row's control and its label rarely share a top
 * edge and a raw top-y comparison would order them by which is taller.
 */
function frameAbove(a: DescribeFrame, b: DescribeFrame): boolean {
  return a.y + a.height <= b.y + WITHIN_EPS;
}

/** Where `node` sits relative to an anchor in reading order. */
type FollowKind = "below" | "band" | "no";

/**
 * Does `node` FOLLOW `anchor` in reading order, and how — on a row below it, or
 * sharing its row band and entirely to its right? The geometric reading of a
 * CSS sibling combinator on a flattened tree.
 *
 * ONE classification, read by both {@link frameAfter} and {@link nearestAfter},
 * so the follower test and the grouping of followers can never disagree:
 * re-deriving the group from a second {@link frameAbove} call put a mutual-case
 * row-mate in the "below" group, where it lost to a band-mate further right.
 *
 * BOTH axes are decided the same way, and for the same reason. Two frames
 * thinner than the tolerance and closer together than it are "above" each other
 * (and, side by side, "left of" each other) — the tolerance cannot tell them
 * apart. Reading such a pair as ordered in both directions is what would let an
 * element to the anchor's LEFT follow it, so a mutual verdict never decides:
 * vertically it falls through to the row rule (a pair of hairlines a fraction
 * of a percent apart is one row), and horizontally it means "no order at all"
 * — two visually coincident marks, neither after the other. The relation is
 * therefore antisymmetric, which the `next` reduction relies on.
 *
 * Mostly not a containment test — an element well inside the anchor is neither
 * above nor entirely right of it. The exception is a child flush with the
 * anchor's bottom or right edge and no thicker than the tolerance (a hairline
 * divider, a scroll indicator): it both follows the anchor and sits
 * {@link frameWithin} it.
 */
function followKind(node: DescribeFrame, anchor: DescribeFrame): FollowKind {
  const below = frameAbove(anchor, node);
  const above = frameAbove(node, anchor);
  if (below !== above) return below ? "below" : "no";
  const right = anchor.x + anchor.width <= node.x + WITHIN_EPS;
  const left = node.x + node.width <= anchor.x + WITHIN_EPS;
  return right !== left && right ? "band" : "no";
}

function frameAfter(node: DescribeFrame, anchor: DescribeFrame): boolean {
  return followKind(node, anchor) !== "no";
}

/**
 * Build a predicate `follows(node)` — true when the node follows a DISTINCT
 * anchor in reading order (the CSS `~` an `after` scope needs).
 *
 * A direct scan, deliberately: unlike {@link containmentTester}'s grid, an
 * index buys nothing here. The pruning a sorted index could offer is subsumed
 * by {@link frameAfter}'s own short-circuit — the first anchor ending above the
 * node settles it — so on every realistic tree shape the sort alone costs more
 * than the scan it replaces (measured 2-13x slower, from a settings-list shape
 * up to a 3k-anchor selector over 1.5k candidates).
 */
function afterTester(anchors: DescribeNode[]): (node: DescribeNode) => boolean {
  return (node) => anchors.some((a) => a !== node && frameAfter(node.frame, a.frame));
}

// Ranking among an anchor's followers, once they are split into the two groups
// below. Each continues past position into frame AREA so that coincident
// top-left corners — a container and the label leaf flush inside it, an
// everyday shape in a flattened tree — resolve to the smaller, more specific
// element rather than to whichever the tree happened to list first (matching
// the "smallest frame wins" doctrine `selectorToFrame` and `nodeAtPoint`
// already rank by), then into the individual extents, which separate the shapes
// area alone cannot: two zero-area rules of different lengths, and a wide-short
// frame against a narrow-tall one. Only frames identical on all four fields are
// left to tree order, and those are indistinguishable to act on anyway.
function comparePick(a: DescribeFrame, b: DescribeFrame): number {
  return frameArea(a) - frameArea(b) || a.width - b.width || a.height - b.height;
}

function compareBandPick(a: DescribeFrame, b: DescribeFrame): number {
  return a.x - b.x || a.y - b.y || comparePick(a, b);
}

function compareBelowPick(a: DescribeFrame, b: DescribeFrame): number {
  return a.y - b.y || a.x - b.x || comparePick(a, b);
}

/**
 * The CSS `+` reduction: keep only the nearest candidate following each anchor,
 * unioned over anchors — as CSS `A + B` is itself the union over every A of the
 * one sibling right after it — and returned in the candidates' own order.
 *
 * "Nearest" splits the followers the way a reader does: one sharing the
 * anchor's row band beats anything on the rows below, because that is the row's
 * own control — the locator `next` exists for. Within each group the leftmost
 * (band) / topmost (below) wins, then the smaller frame.
 *
 * A single direct scan per anchor, for the same reason {@link afterTester} is
 * one: sorting the candidates costs about a dozen naive passes, which the one
 * or two anchors a `next` scope realistically resolves can never amortize. An
 * earlier indexed variant was also a second implementation of these semantics,
 * and the two disagreed on frames near the tolerance.
 *
 * Measured, single-anchor (`next: { text: "Wi-Fi" }`, the shape this exists
 * for): 0.1 ms on a settings-sized screen, 1.2 ms even at the flow tree's
 * 12k-node cap. The quadratic tail is real — 5 ms at 800 nodes, 555 ms at
 * 12k — but only when the anchor selector matches essentially EVERY node,
 * which unions a pick per anchor and is not a locator anyone writes; and it
 * multiplies by the loose-alternative count when a scope is a bare string —
 * at most 32, since a bare string is a leaf and so at most five of
 * MAX_SELECTOR_SCOPES levels can be loose. Unlike {@link afterTester} this
 * cannot short-circuit: it must see every candidate to know which is nearest.
 * An index would cut the tail, but the one this replaced was a second
 * implementation of the rules above and the two disagreed near the tolerance —
 * a correctness bug in the common case is a bad trade for a misuse-case tail.
 *
 * Note that the pick is made over ALL candidates, visible or not: this reduces
 * the match SET, before any condition looks at it. On the platforms whose flow
 * adapters keep zero-area nodes (Vega), a ghost node between the anchor and the
 * real control therefore wins the pick and a `visible` check on it fails —
 * scope by {@link Selector.after} or {@link Selector.within} there instead.
 */
function nearestAfter(candidates: DescribeNode[], anchors: DescribeNode[]): DescribeNode[] {
  if (candidates.length === 0 || anchors.length === 0) return [];
  const picked = new Set<DescribeNode>();
  for (const anchor of anchors) {
    const af = anchor.frame;
    let band: DescribeNode | undefined;
    let below: DescribeNode | undefined;
    for (const c of candidates) {
      if (c === anchor) continue;
      const f = c.frame;
      const kind = followKind(f, af);
      if (kind === "band") {
        if (band === undefined || compareBandPick(f, band.frame) < 0) band = c;
      } else if (kind === "below") {
        if (below === undefined || compareBelowPick(f, below.frame) < 0) below = c;
      }
    }
    const best = band ?? below;
    if (best !== undefined) picked.add(best);
  }
  return candidates.filter((c) => picked.has(c));
}

// Every node matching the selector in the tree, EXCLUDING `root` itself — the
// synthetic full-screen container describe puts at the head of the tree. See the
// long-form rationale in await-ui-element: matching the root would let a broad
// role selector satisfy `visible`/`exists` on any screen. The exclusion covers
// `within` containers too: the synthetic root wraps every screen, so letting it
// satisfy a scope would make `within` vacuous for broad container selectors.
//
// A relational scope is resolved GEOMETRICALLY — never by tree ancestry: the
// flow adapters flatten every platform tree into leaves under one synthetic
// root (see `flow-tree-flatten`), so parent/child structure does not survive to
// replay, while frames do. Every relation requires a DISTINCT node (an element
// never scopes itself, so `a within a` needs two nested elements), and each
// nests: `within: { id: b, within: c }` resolves c's containers first, then
// keeps only the b's sitting inside one of them.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  const all: DescribeNode[] = [];
  const collect = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  for (const child of root.children) collect(child);
  return resolveSelector(all, selector);
}

/**
 * The relational scopes a selector can carry, in the order
 * {@link resolveSelector} applies them. Spelled once and consumed by both
 * layers — the match engine here, and flow YAML's parser, serializer, report
 * stringifiers and loose-alternative expansion — so they cannot drift on which
 * keys are relations.
 */
export const SELECTOR_RELATIONS = ["within", "after", "next"] as const;

export type SelectorRelation = (typeof SELECTOR_RELATIONS)[number];

/**
 * How each scope narrows a match set. `within` and `after` are per-node
 * predicates; `next` reduces the SET (it keeps the nearest follower), which is
 * why the order above applies it last — a scoped `{ any: true, next: X,
 * within: Y }` means "the first element inside Y that follows X", not "the
 * first element after X, if it happens to be inside Y".
 *
 * A `Record` keyed by the relation union, so adding a scope to
 * {@link SELECTOR_RELATIONS} without teaching the engine what it MEANS is a
 * compile error here rather than a scope the resolver silently ignores — which
 * would read as a condition passing on a constraint that never held.
 */
const RELATION_RESOLVERS: Record<
  SelectorRelation,
  (matches: DescribeNode[], scope: DescribeNode[]) => DescribeNode[]
> = {
  within: (matches, scope) => matches.filter(containmentTester(scope)),
  after: (matches, scope) => matches.filter(afterTester(scope)),
  next: (matches, scope) => nearestAfter(matches, scope),
};

/** Own-field matches from `all`, narrowed by every scope the selector carries. */
function resolveSelector(all: DescribeNode[], selector: Selector): DescribeNode[] {
  const regex = selectorTextRegex(selector);
  let matches = all.filter((n) => matchNodeWithRegex(n, selector, regex));
  for (const relation of SELECTOR_RELATIONS) {
    const scope = selector[relation];
    if (scope === undefined) continue;
    matches = RELATION_RESOLVERS[relation](matches, resolveSelector(all, scope));
  }
  return matches;
}

// describe prunes off-screen / zero-size nodes, so a non-zero frame area is a
// cheap, reliable proxy for "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The element a reader "sees first": smallest (y, then x), matching how
// format-tree renders iOS leaves in reading order. Returns undefined for [].
export function firstInReadingOrder(matches: DescribeNode[]): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  for (const n of matches) {
    if (
      best === undefined ||
      n.frame.y < best.frame.y ||
      (n.frame.y === best.frame.y && n.frame.x < best.frame.x)
    ) {
      best = n;
    }
  }
  return best;
}

// Evaluate a wait/assert condition over ALL elements matching a selector.
// `visible` holds if ANY match is on-screen; `hidden` only if NONE is; `text`
// inspects the first VISIBLE match in reading order (falling back to the first
// overall if none is visible) — so a stale zero-area node can't shadow the
// element the check was meant to read, and the check agrees with the failure
// messages (flow assertReason, await-ui-element's timeout note), which quote
// the same visible-first node.
export function evaluateCondition(
  condition: WaitCondition,
  expectedText: string | undefined,
  matches: DescribeNode[],
  textMatch: TextMatchMode = "contains"
): boolean {
  switch (condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (first === undefined || expectedText === undefined) return false;
      // Hoisted subtree text is ADDITIVE evidence, never a replacement: a
      // check the element's own label/value satisfies on a plain describe
      // tree (`equals: "Save"` on a container labelled "Save" that wraps a
      // "Saved successfully" child) must not start failing because the flow
      // adapters stamped a compound `subtreeText` ("Save Saved successfully")
      // onto the node — so the expected text may match either.
      return (
        textMatches(assertText(first), expectedText, textMatch) ||
        textMatches(nodeText(first), expectedText, textMatch)
      );
    }
    default:
      return false;
  }
}

// ── Settle detection ────────────────────────────────────────────────────────

/**
 * A stable fingerprint of the tree's visible structure — every node's role,
 * rounded frame, and text/identifier. Two consecutive identical fingerprints
 * mean the UI has settled (a scroll's momentum has stopped, an animation has
 * finished): the flow runner uses this to wait out a fling before reading or
 * tapping, so a tap can't land mid-deceleration (where a scroll view would
 * swallow it to halt the scroll) and a resolved frame can't be stale by the time
 * we act on it. Frames are rounded to 1e-3 so sub-pixel jitter does not read as
 * motion.
 *
 * The optional `include` predicate restricts the fingerprint to a subset of
 * nodes (children of an excluded node are still walked) — e.g. the flow
 * runner's end-of-scroll check fingerprints only the scrolled region (the
 * `within` container, or the scroll containers under the gesture anchor) so an
 * animating node outside that region can't keep the fingerprint changing and
 * mask the end of the scroll.
 */
export function treeFingerprint(
  root: DescribeNode,
  include?: (node: DescribeNode) => boolean
): string {
  const parts: string[] = [];
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const walk = (node: DescribeNode): void => {
    if (!include || include(node)) {
      const f = node.frame;
      parts.push(
        `${node.role}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}` +
          `|${node.label ?? ""}|${node.value ?? ""}|${node.identifier ?? ""}`
      );
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join("\n");
}

// ── Reverse lookup & selector → frame ──────────────────────────────────────

export function frameContains(frame: DescribeFrame, x: number, y: number): boolean {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node whose frame contains
 * the tapped point. "Smallest" picks the most specific element (a button over
 * its container). Skips the synthetic root. Returns undefined if nothing
 * sensible is under the point.
 */
export function nodeAtPoint(
  root: DescribeNode,
  point: { x: number; y: number }
): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  const walk = (node: DescribeNode): void => {
    if (isVisible(node) && frameContains(node.frame, point.x, point.y)) {
      if (best === undefined || frameArea(node.frame) < frameArea(best.frame)) best = node;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return best;
}

// Does the regex consume the WHOLE non-empty string? The regex analog of an exact
// text match, for ranking: `^Order #\d+$`-style full hits on a leaf must beat
// a container whose aggregated label merely contains the same text. Wrapping
// in `^(?:…)$` is safe for any valid pattern (non-capturing, so backreference
// numbering is unchanged; inner `^`/`$` stay valid).
function fullConsumptionRegex(selector: Selector): RegExp | undefined {
  return selector.textMatches === undefined
    ? undefined
    : uiTreeMatchInternals.createRegExp(`^(?:${selector.textMatches})$`);
}

// Exactness is GRADED, not a yes/no count, and the grades exist because
// folding erased the distinction ranking depends on.
//
// The scale: a field scores LITERAL when the node's text equals the selector's
// once case is folded and nothing else, FOLDED when it takes the full fold to
// make them equal, and nothing when it merely contains the needle. Folding is
// what LOCATES an element the author could not otherwise name (a currency NBSP,
// a bidi-wrapped handle), but between two elements that both match, the one
// spelled exactly as asked for is the better answer — and on a real screen the
// other one is usually a decorative sibling.
//
// Ungraded, this retargeted taps. An icon-only 28x28 button labelled
// "Sign<NBSP>in" used to score 0 here and could never outrank the 420x70 button
// whose text is literally "Sign in"; once both scored 1 they tied, the tiebreak
// is "smallest frame wins", and `tap: { text: "Sign in" }` started firing the
// icon — silently, with the step still reporting pass.
const EXACT_LITERAL = 2;
const EXACT_FOLDED = 1;

// The comparison equalsCI made before it folded: case-insensitive and nothing
// more. Only ranking asks this — a MATCH is still decided by the folded form.
function literalEqualsCI(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

function exactTextScore(actual: string | undefined, expected: string): number {
  if (!equalsCI(actual, expected)) return 0;
  return literalEqualsCI(actual, expected) ? EXACT_LITERAL : EXACT_FOLDED;
}

// How exactly this node matches the selector's provided fields, summed over
// them: full-string hits rather than substring / partial ones, and among those,
// literal spellings ahead of ones only the fold equates.
function exactFieldCount(
  node: DescribeNode,
  selector: Selector,
  fullTextRegex: RegExp | undefined
): number {
  let count = 0;
  if (selector.text !== undefined) {
    count += Math.max(
      exactTextScore(node.label, selector.text),
      exactTextScore(node.value, selector.text)
    );
  }
  if (
    fullTextRegex !== undefined &&
    (regexMatchesNonEmpty(fullTextRegex, node.label) ||
      regexMatchesNonEmpty(fullTextRegex, node.value))
  ) {
    // A regex is never folded — consuming the whole string IS the literal grade.
    count += EXACT_LITERAL;
  }
  if (selector.identifier !== undefined) {
    count += exactTextScore(node.identifier, selector.identifier);
  }
  if (selector.role !== undefined) count += exactTextScore(node.role, selector.role);
  return count;
}

/**
 * Resolve a selector to the on-screen frame of its best visible match — the
 * element a `tap`/`type` action should target. An accessible container (e.g. a
 * Touchable on iOS) aggregates its descendants' labels, so a substring text
 * selector matches the container as well as the leaf that actually carries the
 * text — and the container's centre can sit over a different nested child
 * entirely. Matches are therefore ranked: exact field matches beat substring
 * hits, then the smallest frame wins (the most specific element, mirroring
 * nodeAtPoint's reverse lookup), with reading order as the final tiebreak.
 * Returns undefined when no visible element matches.
 *
 * The universal selector (flow YAML's `any: true`) is the one case that ranking
 * cannot serve: with no field to be exact about, "smallest" degenerates to
 * "whatever hairline spacer the scope happens to contain". A field-less
 * selector names a REGION, not a kind of element, so its matches are read the
 * way every condition reads a match set — first in reading order — which keeps
 * the element an action targets the same one an `assert` would quote.
 *
 * {@link compareBelowPick} rather than {@link firstInReadingOrder}, though:
 * both order by (y, x), but a bare reading order leaves an exact positional
 * tie — a container and the leaf flush at its top-left corner, the everyday
 * flattened-tree shape the sibling picks already guard against — to be settled
 * by the order the adapter happened to emit them in. Two frames with different
 * extents means two different tap centres, so the tie continues into "most
 * specific" instead.
 */
export function selectorToFrame(root: DescribeNode, selector: Selector): DescribeFrame | undefined {
  const visible = findAll(root, selector).filter(isVisible);
  if (visible.length === 0) return undefined;
  if (!hasOwnConstraint(selector)) {
    let first: DescribeNode | undefined;
    for (const n of visible) {
      if (first === undefined || compareBelowPick(n.frame, first.frame) < 0) first = n;
    }
    return first?.frame;
  }
  const fullTextRegex = fullConsumptionRegex(selector);
  let best: DescribeNode | undefined;
  let bestExact = -1;
  for (const n of visible) {
    const exact = exactFieldCount(n, selector, fullTextRegex);
    if (best === undefined || exact !== bestExact) {
      if (exact > bestExact) {
        best = n;
        bestExact = exact;
      }
      continue;
    }
    const areaDelta = frameArea(n.frame) - frameArea(best.frame);
    if (
      areaDelta < 0 ||
      (areaDelta === 0 &&
        (n.frame.y < best.frame.y || (n.frame.y === best.frame.y && n.frame.x < best.frame.x)))
    ) {
      best = n;
    }
  }
  return best?.frame;
}

/**
 * Derive the most stable selector that identifies a node, used by the recorder
 * to turn a tapped element into a `tap: { selector }` step. Prefers identifier,
 * then text; falls back to a specific (non-generic) role. Returns null when the
 * node has nothing stable to match on — the caller then keeps coordinates.
 */
const GENERIC_ROLES = new Set([
  "axgroup",
  "group",
  "view",
  "other",
  "axother",
  "none",
  "viewgroup",
  "android.view.view",
  "android.view.viewgroup",
]);

export function deriveSelector(node: DescribeNode): Selector | null {
  if (node.identifier && node.identifier.trim()) return { identifier: node.identifier };
  // Derive text from label OR value individually — never nodeText's joined
  // form: matchNode compares a text selector against label and value
  // separately, so a joined "Volume 50%" would match nothing, not even the
  // node it was derived from. Label first — a value like "50%" is the
  // volatile part of a control, the label is the stabler replay anchor.
  // Only visibly-rendered text counts as stable: icon-font labels are Private
  // Use Area glyphs that serialize to invisible YAML (see hasVisibleText), so
  // a node carrying only those falls through to role/coordinates.
  const text = [node.label, node.value].map((t) => t?.trim()).find((t) => t && hasVisibleText(t));
  if (text) return { text };
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) return { role: node.role };
  return null;
}

// ── Tree fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch the describe tree for a device, resolving services through the registry
 * (the chromium CDP session is the only one that flows in as a service). iOS /
 * Android describe resolve their own services internally; Vega reads the
 * on-device automation toolkit's page source (`describeVega`).
 */
export async function fetchTree(
  registry: Registry,
  device: DeviceInfo,
  opts: { bundleId?: string } = {}
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return describeIos(registry, device, { bundleId: opts.bundleId });
  }
  if (device.platform === "android") {
    return describeAndroid(registry, device.id);
  }
  if (device.platform === "chromium") {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    return describeChromium(api);
  }
  if (device.platform === "vega") {
    return describeVega(device.id);
  }
  throw new Error(`ui-tree matching is not supported on platform "${device.platform}"`);
}
