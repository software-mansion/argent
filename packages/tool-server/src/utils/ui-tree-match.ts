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
      .describe(
        "Case-insensitive substring of the element's visible label or value. Compared on FOLDED text: a non-breaking space matches a plain one, a run of spaces or tabs matches a single space, and an LTR bidi wrapper around otherwise left-to-right text is ignored, so you can type what you see. Characters that change the rendering are NOT folded (bidi controls that reorder, a soft hyphen, emoji ZWJ/variation selectors, and a line break, which no number of spaces matches). A leading or trailing space is significant and constrains the match; a value with no visible character at all is rejected."
      ),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The element's identifier (accessibilityIdentifier / resource-id / testid), matched case-insensitively as the exact identifier or the unqualified resource-id name ('submit' matches 'com.example.app:id/submit'). Never folded — an identifier is a machine key, not rendered text — so it must be spelled exactly. A value that is only whitespace matches nothing."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's role (e.g. AXButton, button, TextView). Folded like `text`; a value of only invisible characters folds away to nothing and so matches nothing, rather than everything."
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
// string. Both literal modes fold first (see foldText). `contains` (default) is
// a case-insensitive folded substring. It keeps a leading or trailing space in
// the expected string as a word boundary. `equals` is a case-insensitive folded
// full-string match, trimmed at both ends (so "1" no longer satisfies "10"). Both
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
// UI text is not the text an author types: a non-breaking space in a label,
// bidi isolates around a name, a soft hyphen from a copy-paste. These survive
// `toLowerCase()`, so a comparison fails on two strings that read the same on
// screen. Every literal comparison folds both sides first, but `matches`
// (regex) is exempt. Zero width alone does not make a character safe to remove:
// the test is whether the removal changes the glyphs drawn or their order.

/** Space-like codepoints that are not U+0020. NBSP, narrow NBSP, ideographic, en/em quad, etc. */
const SPACE_LIKE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;

/**
 * Whitespace that breaks the line. It is the one part of the whitespace family
 * the run collapse must not equate with a space. A run with no break collapses
 * to one space. A run that breaks the line collapses to one newline per break,
 * because one newline for a whole run equates one break with two. Interior runs
 * only: an edge break is the outer whitespace {@link foldText} trims.
 *
 * Global, and used only with `String.prototype.match`, which resets `lastIndex`.
 */
const LINE_BREAKS_G = /\r\n|[\n\r\v\f\u2028\u2029]/gu;

/**
 * Invisible formatting that cannot change a glyph or its position in any
 * context: ZWSP, word joiner, the invisible math operators, the deprecated
 * format controls, BOM. The gaps in the class skip the sequence builders and
 * the unassigned U+2065.
 */
const INVISIBLE = /[\u200b\u2060-\u2064\u206a-\u206f\ufeff]/gu;

/**
 * The LTR-forcing directional controls - LRM, LRE, PDF, LRO, LRI, FSI, PDI.
 * Folded only when {@link BIDI_SENSITIVE} finds nothing the bidi algorithm can
 * reorder, because there each of these asks for the order that already happens.
 * The RTL counterparts never fold. A string that holds one keeps its LTR
 * controls too, because a fold of half a pair rewrites the string, not the
 * screen.
 */
const LTR_BIDI = /[\u200e\u202a\u202c\u202d\u2066\u2068\u2069]/gu;

/**
 * True when the string holds content whose bidi order depends on more than
 * logical order: a strong RTL or Arabic-number character, or an RTL-forcing
 * control. Over-inclusive, because a false positive only folds less.
 *
 * Not global, and used only with `.test`, so there is no `lastIndex` to reset.
 */
const BIDI_SENSITIVE =
  /[\u061c\u200f\u202b\u202e\u2067\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

// Never folded - invisible alone, but each builds or moves a glyph in sequence:
//
// - U+200D ZWJ and U+FE00-FE0F variation selectors build emoji sequences: the
//   transgender flag is U+1F3F3 VS16 ZWJ U+26A7 VS16, one glyph, not two.
// - U+200C ZWNJ suppresses ligatures in Arabic, Persian and Indic scripts.
// - U+180E suppresses Arabic cursive joining as ZWNJ does.
// - U+00AD SOFT HYPHEN paints a real hyphen where the line breaks.
// - The RTL directional controls, plus their LTR counterparts in a bidi string.
//   See {@link LTR_BIDI} and {@link BIDI_SENSITIVE}.

const foldCache = new Map<string, string>();
/**
 * Large enough for one worst-case tree, so the clear below costs one refill.
 * A 12k-node tree folds a label and a value per node, so up to 24k keys. A
 * smaller cap cleared the map several times per `findAll` and doubled its cost.
 * This cap holds about 4 MB.
 */
const FOLD_CACHE_MAX = 32_768;

/**
 * The comparable form of a piece of UI text:
 * - invisible formatting stripped,
 * - every {@link SPACE_LIKE} codepoint made a plain space,
 * - each whitespace run collapsed (see {@link LINE_BREAKS_G}),
 * - trimmed, lowercased, then normalized to NFC.
 *
 * NFC, not NFKC: NFKC folds ligatures, fullwidth forms and styled
 * alphabets, so a styled display name equates with the plain one it imitates.
 * The strip is conditional: {@link INVISIBLE} always, {@link LTR_BIDI} only
 * when the string holds no {@link BIDI_SENSITIVE} content to reorder.
 */
export function foldText(value: string): string {
  return foldLoose(value).trim();
}

/**
 * {@link foldText} without the trim. Leading and trailing whitespace each
 * survive as one space, which a substring test needs. A boundary space is the
 * word boundary an author writes, because "Taps: 3" also matches "Taps: 30".
 */
function foldLoose(value: string): string {
  return foldWith(value, !isBidiSensitive(value));
}

/**
 * True when the string holds content the bidi algorithm can reorder, and so
 * must keep its {@link LTR_BIDI} controls. Asked on the {@link foldWith} form,
 * with {@link INVISIBLE} removed.
 */
function isBidiSensitive(value: string): boolean {
  return BIDI_SENSITIVE.test(value.replace(INVISIBLE, ""));
}

/**
 * Fold two strings for one comparison, and decide the conditional LTR strip
 * once for the pair. Per string the strip is not monotonic under substring, and
 * {@link includesCI} is a substring test. A label with one RTL word keeps its
 * U+202A/U+202C wrappers, while a Latin-only fragment of it loses them. Either
 * side that is bidi-sensitive keeps both, the safe direction.
 */
function foldPairLoose(a: string, b: string): [string, string] {
  const stripLtr = !isBidiSensitive(a) && !isBidiSensitive(b);
  return [foldWith(a, stripLtr), foldWith(b, stripLtr)];
}

function foldWith(value: string, stripLtr: boolean): string {
  const key = `${stripLtr ? "1" : "0"}${value}`;
  const hit = foldCache.get(key);
  if (hit !== undefined) return hit;
  // Remove the invisibles before composition. An invisible between a base letter
  // and its combining mark blocks NFC, which leaves a decomposed grapheme.
  let stripped = value.replace(INVISIBLE, "");
  if (stripLtr) stripped = stripped.replace(LTR_BIDI, "");
  const folded = stripped
    .replace(SPACE_LIKE, " ")
    // One space per whitespace run, or one newline per line break in an
    // interior run. See {@link LINE_BREAKS_G}. `\s+` is greedy, so an interior
    // run is one with a non-space neighbour at each end.
    .replace(/\s+/g, (run, at: number, whole: string) => {
      if (at === 0 || at + run.length === whole.length) return " ";
      const breaks = run.match(LINE_BREAKS_G)?.length ?? 0;
      return breaks > 0 ? "\n".repeat(breaks) : " ";
    })
    .toLowerCase()
    // Compose last, because `toLowerCase` is not NFC-preserving. Where the
    // uppercase spelling has no precomposed code point, an NFC pass before the
    // case fold left one visibly identical pair unequal.
    .normalize("NFC");
  // Trees are re-read on every poll, so the same strings recur constantly.
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(key, folded);
  return folded;
}

/**
 * True when two strings differ only by a compatibility variant: a rendered `…`
 * against three typed dots, a ligature, a fullwidth form. The fold keeps those
 * apart (see {@link foldText}), so this explains the miss instead.
 */
export function compatibilityVariantOf(actual: string, expected: string): boolean {
  if (foldText(actual) === foldText(expected)) return false;
  // NFKC is NFKD plus canonical composition, so a leading NFKD is redundant.
  const compat = (s: string): string => foldText(s.normalize("NFKC"));
  return compat(actual) === compat(expected);
}

/**
 * The substring form of {@link compatibilityVariantOf}. Both `contains` and a
 * selector's own `text` are substring tests, so a whole-string question misses.
 */
export function compatibilityVariantIn(haystack: string, needle: string): boolean {
  if (includesCI(haystack, needle)) return false;
  if (foldText(needle) === "") return false;
  const compat = (s: string): string => foldLoose(s.normalize("NFKC"));
  return compat(haystack).includes(compat(needle));
}

/**
 * True for a character that draws no glyph alone but builds one in sequence:
 * ZWNJ, ZWJ, both variation-selector blocks and the emoji tag characters. A
 * code-point predicate, because `no-misleading-character-class` bans the class.
 */
function isSequenceBuilding(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** The directional controls: no glyph of their own, but they reorder text. */
const DIRECTIONAL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** {@link DIRECTIONAL}, global - for {@link quoteScreenText}'s replace. */
const DIRECTIONAL_G = new RegExp(DIRECTIONAL.source, "gu");

/**
 * The two never-folded characters that draw no glyph but change which glyphs a
 * screen draws: U+00AD and U+180E. Both are `Default_Ignorable_Code_Point`, so
 * a note needs a separate lead for them rather than one about inert noise.
 */
const RENDERING_AFFECTING = /[\u00ad\u180e]/u;

/**
 * Every default-ignorable code point except the sequence-building ones - the
 * characters whose removal leaves the same appearance. The property, not `Cf`:
 * `Cf` holds the concatenation marks and misses U+034F, which is `Mn`.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
/** {@link DEFAULT_IGNORABLE}, non-global - for a single-character test. */
const DEFAULT_IGNORABLE_ONE = new RegExp(DEFAULT_IGNORABLE.source, "u");

/** Every inert ignorable in `text`, in order, sequence-builders excluded. */
function inertIgnorables(text: string): string[] {
  return (text.match(DEFAULT_IGNORABLE) ?? []).filter((ch) => !isSequenceBuilding(ch));
}

/** `text` with every inert ignorable removed - what the eye reads. */
function withoutInertIgnorables(text: string): string {
  return text.replace(DEFAULT_IGNORABLE, (ch) => (isSequenceBuilding(ch) ? ch : ""));
}

/** `text` with every inert ignorable removed except `keep`. */
function keepOnlyIgnorable(text: string, keep: string): string {
  return text.replace(DEFAULT_IGNORABLE, (ch) => (isSequenceBuilding(ch) || ch === keep ? ch : ""));
}

/** Every inert ignorable in `text`, tagged with the count of visible characters before it. */
function placedIgnorables(text: string): string[] {
  const placed: string[] = [];
  let before = 0;
  for (const ch of text) {
    if (DEFAULT_IGNORABLE_ONE.test(ch) && !isSequenceBuilding(ch)) {
      placed.push(`${before}\u0000${ch}`);
    } else {
      before += 1;
    }
  }
  return placed;
}

/**
 * The ignorable characters that sit differently in the two strings: a different
 * count, or the same count at another position. A count alone is blind to a
 * move, so the position tag is what makes a move a difference.
 */
function displacedIgnorables(actual: string, expected: string): string[] {
  const tally = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const placed of placedIgnorables(s)) {
      counts.set(placed, (counts.get(placed) ?? 0) + 1);
    }
    return counts;
  };
  const a = tally(actual);
  const b = tally(expected);
  const moved = [...new Set([...a.keys(), ...b.keys()])].filter(
    (placed) => (a.get(placed) ?? 0) !== (b.get(placed) ?? 0)
  );
  return [...new Set(moved.map((placed) => placed.slice(placed.indexOf("\u0000") + 1)))];
}

/**
 * The ignorable characters that block the comparison, not merely the ones that
 * differ - {@link displacedIgnorables} is too wide under `contains`. Ask the
 * comparator once per character. When none alone is necessary, name them all.
 */
function blockingIgnorables(
  actual: string,
  expected: string,
  holds: (a: string, b: string) => boolean
): string[] {
  const displaced = displacedIgnorables(actual, expected);
  const blocking = displaced.filter(
    (ch) => !holds(keepOnlyIgnorable(actual, ch), keepOnlyIgnorable(expected, ch))
  );
  return blocking.length > 0 ? blocking : displaced;
}

/**
 * A note that names the difference between two strings that look equal. Its
 * gate is wider than {@link foldText}: the comparator holds once every inert
 * default-ignorable is removed. It must not call a real rendering difference
 * invisible, so it excludes {@link isSequenceBuilding} characters and gives
 * {@link DIRECTIONAL} and {@link RENDERING_AFFECTING} their own leads.
 */
export function confusableTextNote(actual: string, expected: string): string | undefined {
  if (actual === expected) return undefined;
  // Remove the ignorables, then ask the comparator rather than raw `===`,
  // because only the comparator that failed folds both sides. With `===` any
  // difference the fold absorbs, such as an NBSP, suppressed the note.
  const visible = withoutInertIgnorables;
  const bareActual = visible(actual);
  const bareExpected = visible(expected);
  // Raw equality sits beside the folded test so the gate only widens: a pair
  // that folds to nothing is equal as strings, while `equalsCI` refuses it.
  if (bareActual !== bareExpected && !equalsCI(bareActual, bareExpected)) return undefined;
  return ignorableDifferenceNote(actual, expected, equalsCI);
}

const codepointName = (ch: string): string =>
  `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * How many code points {@link codepoints} prints of each string. At about seven
 * characters each, this holds the two dumps to roughly 700 characters.
 */
const CODEPOINT_DUMP_MAX = 48;

/**
 * A string as code points, windowed on the blocking character when the whole
 * string does not fit {@link CODEPOINT_DUMP_MAX}. `assertText` prefers the
 * hoisted `subtreeText`, so one card produced an 11,532 character reason.
 */
function codepoints(text: string, blocking: readonly string[] = []): string {
  const chars = Array.from(text);
  if (chars.length <= CODEPOINT_DUMP_MAX) return chars.map(codepointName).join(" ");
  const found = chars.findIndex((ch) => blocking.includes(ch));
  const centre = found === -1 ? 0 : found;
  const start = Math.min(
    Math.max(0, centre - Math.floor(CODEPOINT_DUMP_MAX / 2)),
    chars.length - CODEPOINT_DUMP_MAX
  );
  const end = start + CODEPOINT_DUMP_MAX;
  const body = chars.slice(start, end).map(codepointName).join(" ");
  return `${start > 0 ? "… " : ""}${body}${end < chars.length ? " …" : ""}`;
}

/**
 * The shared body of the two confusable notes: pick the lead that names the
 * characters that differ, then print both strings as code points. A reorder
 * wins a mixed difference, and only the last branch says "invisible". `holds`
 * is the comparator {@link blockingIgnorables} asks.
 */
function ignorableDifferenceNote(
  actual: string,
  expected: string,
  holds: (a: string, b: string) => boolean
): string | undefined {
  const differing = blockingIgnorables(actual, expected, holds);
  if (differing.length === 0) return undefined;
  const lead = differing.some((ch) => DIRECTIONAL.test(ch))
    ? "the two strings differ only in directional formatting, which draws nothing itself but " +
      "REORDERS the characters around it, so the screen does not read the way the text does"
    : differing.some((ch) => RENDERING_AFFECTING.test(ch))
      ? "the two strings differ in a character that draws nothing itself but changes what IS " +
        "drawn — a soft hyphen paints a real hyphen where the line breaks, U+180E breaks " +
        "Arabic cursive joining as ZWNJ does — so the screen and the text really do differ"
      : "the two strings differ only in invisible characters";
  return (
    `${lead} — actual [${codepoints(actual, differing)}] ` +
    `vs expected [${codepoints(expected, differing)}]`
  );
}

/**
 * The substring form of {@link confusableTextNote}: the needle failed to appear
 * in the label only because of inert ignorable characters. Both strings print
 * whole, not as the matched region, because an index cannot map back.
 */
export function confusableTextNoteIn(haystack: string, needle: string): string | undefined {
  if (includesCI(haystack, needle)) return undefined;
  const bareHaystack = withoutInertIgnorables(haystack);
  const bareNeedle = withoutInertIgnorables(needle);
  if (!includesCI(bareHaystack, bareNeedle)) return undefined;
  return ignorableDifferenceNote(haystack, needle, includesCI);
}

/**
 * Screen text, made safe for a failure message. A label with an unbalanced
 * U+202E survives the fold, and quoted as it stands it reverses every character
 * after it. Replace the directional controls with names, and keep the rest.
 */
export function quoteScreenText(text: string): string {
  return text.replace(
    DIRECTIONAL_G,
    (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`
  );
}

/**
 * A note that names the invisible characters in one string, with no comparison.
 * {@link confusableTextNote} cannot serve a `matches` step, because its
 * "expected" is a regex, and `matches` is exempt from the fold. `pattern` keeps
 * the note relevant: it re-tests the pattern with the ignorables removed.
 */
export function ignorableTextNote(text: string, pattern?: string): string | undefined {
  const found = inertIgnorables(text);
  if (found.length === 0) return undefined;
  // Speak only when these characters are the reason the pattern missed. A
  // re-test with them removed answers that directly.
  if (pattern !== undefined) {
    let stripped: RegExp;
    try {
      stripped = uiTreeMatchInternals.createRegExp(pattern);
    } catch {
      return undefined;
    }
    if (!stripped.test(withoutInertIgnorables(text))) return undefined;
  }
  const names = [...new Set(found)]
    .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
  // The same three-way lead as {@link confusableTextNote}: a U+202E is not
  // invisible.
  const lead = found.some((ch) => DIRECTIONAL.test(ch))
    ? `the text carries directional formatting [${names}], which draws nothing itself but ` +
      `REORDERS the characters around it, so the screen does not read the way the text does`
    : found.some((ch) => RENDERING_AFFECTING.test(ch))
      ? `the text carries characters [${names}] that draw nothing themselves but change what IS ` +
        `drawn — a soft hyphen paints a real hyphen where the line breaks, U+180E breaks Arabic ` +
        `cursive joining as ZWNJ does`
      : `the text carries invisible characters [${names}]`;
  return (
    `${lead} — the pattern must account for them (a regular expression is deliberately never ` +
    `folded, so they are matched literally)`
  );
}

/**
 * Why a text selector matched nothing, when something on screen nearly did.
 * `candidates` is the node set the caller already narrowed to what its selector
 * could otherwise accept, because a wider search lets a look-alike claim the
 * note. Both halves - {@link confusableTextNoteIn} and
 * {@link compatibilityVariantIn} - use the label and the value only, and a
 * substring test. The invisible question comes first, because it names exact
 * code points.
 */
export function selectorMissNote(
  candidates: readonly DescribeNode[],
  wanted: string
): string | undefined {
  if (wanted === "") return undefined;
  const texts: string[] = [];
  for (const node of candidates) {
    for (const text of [node.label, node.value]) if (text) texts.push(text);
  }
  for (const text of texts) {
    const note = confusableTextNoteIn(text, wanted);
    if (note !== undefined) return `the screen does show "${quoteScreenText(text)}" — ${note}`;
  }
  for (const text of texts) {
    if (compatibilityVariantIn(text, wanted)) return typographicVariantNote(text);
  }
  return undefined;
}

/**
 * The sentence that names a compatibility variant the screen renders. Shared by
 * its two callers, so a selector miss and a `text` miss cannot drift apart.
 */
export function typographicVariantNote(shown: string): string {
  return (
    `the screen does show "${quoteScreenText(shown)}", which differs only by a typographic ` +
    `variant (a rendered "…" is ONE character, not three dots; likewise ligatures and ` +
    `fullwidth forms). Those are not folded together, because doing so would also equate a ` +
    `styled display name with the plain one it imitates. Copy the characters the app ` +
    `actually renders.`
  );
}

export function includesCI(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  // Both sides untrimmed, so a boundary space still constrains the match (see
  // {@link foldLoose}), and folded as a pair so a needle copied from the label
  // stays a substring of it (see {@link foldPairLoose}).
  const [hay, ndl] = foldPairLoose(haystack, needle);
  // A needle that folds to nothing is no constraint at all: `"".includes()` is
  // true of every string, so the check can never fail. Only an invisible-only
  // needle does that - a `role` of a lone ZWSP folds to "". A whitespace-only
  // needle is allowed: it folds loosely to " ", which still constrains it.
  if (ndl === "") return false;
  return hay.includes(ndl);
}

export function equalsCI(actual: string | undefined, expected: string): boolean {
  // Folded as a pair so the two comparators agree - see {@link foldPairLoose}.
  const [got, wanted] = foldPairLoose(actual ?? "", expected);
  // Same rule as includesCI: an expectation that folds to nothing is no
  // constraint, so it must not equal a textless element.
  if (wanted === "") return false;
  // Nothing survives the trim, so the expectation is pure whitespace - odd, but
  // a real constraint. Compare untrimmed to keep a label of one space distinct.
  if (wanted.trim() === "") return got === wanted;
  return got.trim() === wanted.trim();
}

/**
 * Identifier matching: case-insensitive EXACT match, or the unqualified name of
 * an Android resource-id — `submit` matches `com.example.app:id/submit` — so a
 * caller never needs the package prefix. Deliberately NOT a substring test: an
 * identifier names one element, and substring matching lets a short needle
 * capture an unrelated id (`save` must not match `autosave-banner`), which is
 * how a loose flow selector's identifier-first pass could hijack a tap.
 *
 * Not folded either, on both sides. A fold is justified by what the eye cannot
 * distinguish, and an identifier is never rendered. It is a machine key, so a
 * fold made `row:id/save ` match `row:id/save` and merged distinct testids.
 */
export function identifierMatches(actual: string | undefined, needle: string): boolean {
  if (!actual) return false;
  // A needle that is blank in any spelling names no element. Only the gate
  // folds, so it catches every spelling of blank at once.
  if (foldText(needle) === "") return false;
  const key = actual.toLowerCase();
  const wanted = needle.toLowerCase();
  return key === wanted || key.endsWith(`:id/${wanted}`);
}

/** @internal A narrow seam for verifying regex compilation lifetime in tests. */
export const uiTreeMatchInternals = {
  createRegExp(pattern: string): RegExp {
    return new RegExp(pattern);
  },
  /** How many folds are cached right now - for pinning {@link FOLD_CACHE_MAX}. */
  foldCacheSize(): number {
    return foldCache.size;
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

// Exactness is graded, not a yes/no count, because the fold erased the
// distinction that ranking depends on. A field scores LITERAL when the node's
// text equals the selector's under a case fold alone, FOLDED when the full fold
// is needed, and nothing when it merely contains the needle. Ungraded, an
// icon-only 28x28 button labelled "Sign<NBSP>in" tied with the real 420x70 one,
// and the smallest-frame tiebreak then chose the icon.
const EXACT_LITERAL = 2;
const EXACT_FOLDED = 1;

// The comparison equalsCI made before the fold: case-insensitive and nothing
// more. Only ranking asks this - the folded form still decides a match.
function literalEqualsCI(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase() === expected.toLowerCase();
}

function exactTextScore(actual: string | undefined, expected: string): number {
  if (!equalsCI(actual, expected)) return 0;
  return literalEqualsCI(actual, expected) ? EXACT_LITERAL : EXACT_FOLDED;
}

// How exactly this node matches the selector's provided fields, summed over
// them: full-string hits first, then literal spellings ahead of folded ones.
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
    // A regex is never folded, so full consumption is the literal grade.
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
