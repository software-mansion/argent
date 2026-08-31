import { z } from "zod";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { describeIos } from "../tools/describe/platforms/ios";
import { describeAndroid } from "../tools/describe/platforms/android";
import { describeChromium } from "../tools/describe/platforms/chromium";
import { describeVega } from "../tools/describe/platforms/vega";
import { chromiumCdpRef, type ChromiumCdpApi } from "../blueprints/chromium-cdp";

/**
 * Shared tree matching: `await-ui-element`, the flow directives (`tap`, `type`,
 * `assert`) and the recorder's reverse lookup all resolve selectors through it.
 */

/**
 * True when `text` contains at least one visibly-rendered character. Icon fonts
 * expose glyphs as Private Use Area code points and zero-width / format
 * characters render as nothing: a constraint made only of those displays as
 * EMPTY in flow YAML and at replay matches an element no reader can predict.
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[\p{Cf}\p{Co}\p{Cc}]/gu, "").trim().length > 0;
}

/**
 * The fields every selector representation shares, without the non-empty
 * refinement, so a flow-only text constraint can replace `text` while reusing
 * the same identifier/role validation.
 */
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
        "Case-insensitive substring of the element's visible label or value. Compared on FOLDED text: a non-breaking space matches a plain one, a run of spaces or tabs matches a single space, and an LTR bidi wrapper around otherwise left-to-right text is ignored, so you can type what you see. Characters that change which glyphs are drawn, or their order, are NOT folded (bidi controls that reorder, a soft hyphen, emoji ZWJ/variation selectors, and a line break, which no number of spaces matches — but take the break from the text `describe` prints, not from the layout, because a label the screen draws on two lines usually reaches the tree as one). One that only moves where a line breaks IS folded away (a zero-width space, a word joiner, a byte-order mark). A leading or trailing space is significant and constrains the match; a value with no visible character at all is rejected."
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
   * YAML), tested unanchored and case-sensitive against the node's OWN
   * label/value, deliberately not the hoisted `subtreeText`: subtree matching
   * would make every unshielded ancestor of a text leaf match too, degrading
   * the exact-beats-substring ranking actions rely on. A type-level extension,
   * not a schema field, so the `await-ui-element` tool surface doesn't grow.
   */
  textMatches?: string;
  /**
   * Flow-only container scope (`{ text: "Delete", within: { id: "card" } }` in
   * flow YAML): the node's frame must sit inside the frame of a DISTINCT
   * element matching this selector. Geometric, not tree-ancestry: the flow
   * adapters flatten every platform tree into leaves under one synthetic root
   * (see `flow-tree-flatten`), so ancestry does not survive to replay. Scopes
   * chain outward (`a within b within c`). Resolved by {@link findAll}, which
   * sees the whole tree; {@link matchNode} evaluates own fields only.
   */
  within?: Selector;
  /**
   * Flow-only general-sibling scope (`{ role: Switch, after: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `~` combinator: the node must FOLLOW a distinct
   * element matching this selector in reading order (see {@link followKind}).
   * Geometric for the same reason `within` is. Resolved by {@link findAll}.
   */
  after?: Selector;
  /**
   * Flow-only adjacent-sibling scope (`{ role: Switch, next: { text: "Wi-Fi" } }`
   * in flow YAML) — the CSS `+` combinator: like {@link after}, but only the
   * NEAREST following match is kept per anchor. The "control belonging to this
   * row's label" locator. Resolved by {@link findAll}.
   */
  next?: Selector;
};

export type WaitCondition = "exists" | "visible" | "hidden" | "text";

// How a `text` condition compares the located element's text to the expected
// string. Both literal modes fold first (see foldText). `contains` (default) is
// a case-insensitive folded substring, and keeps a leading or trailing space in
// the expected string, which must then match a real space in the label - it is
// not an end-of-text anchor; `equals` is the folded full-string
// match, trimmed at both ends (so "1" no longer satisfies "10"). `matches` is a
// JS regex tested unanchored and CASE-SENSITIVELY - a regex carries its
// semantics in the pattern, and forcing `i` would betray `\d{2}`-style
// precision. `matches` is flow-only; the await-ui-element schema stays
// contains/equals.
export type TextMatchMode = "contains" | "equals" | "matches";

export function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

// Text a `text` condition reads (and its failure messages quote). Prefers
// `subtreeText` — hoisted from descendants by the flow adapters — so a check
// against a testID container reads the text it visibly wraps rather than its
// own (empty) label. Selector matching stays on `nodeText`, so `tap`/`{ text }`
// targeting is unaffected.
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
 * because one newline for a whole run equates one break with two. Counted in
 * an edge run too: {@link foldText} trims those away, but {@link foldLoose}
 * keeps them, and there they are the break a substring needle asked for.
 *
 * Global, and used only with `String.prototype.match`, which resets `lastIndex`.
 */
const LINE_BREAKS_G = /\r\n|[\n\r\v\f\u2028\u2029]/gu;

/**
 * Invisible formatting that changes no glyph and no glyph ORDER: ZWSP, word
 * joiner, the invisible math operators, the deprecated format controls, BOM.
 * The gaps in the class skip the sequence builders and the unassigned U+2065.
 *
 * Three of them do move a glyph's POSITION, and are folded anyway: U+200B adds
 * a line-break opportunity, U+2060 and U+FEFF suppress one. Measured in
 * Chromium at 20px text, `ตา<ZWSP>กลม` draws as ตา / กลม and `ตาก<ZWSP>ลม` as
 * ตาก / ลม, while `日本<U+2060>語` moves the break the bare string takes. A
 * stray ZWSP from a copy-paste is the common case and dropping it is the point
 * of the fold, so this is deliberate — but it is a real cost, not an empty
 * set: `equals` cannot pin the word segmentation of a Thai, Lao or Khmer
 * label, nor a CJK no-break, and reports a pass rather than reporting that it
 * cannot. The layout itself stays legible in the frame `describe` reports.
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
/** {@link LTR_BIDI}, non-global - for a single-character test. */
const LTR_BIDI_ONE = new RegExp(LTR_BIDI.source, "u");

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

/**
 * Large enough for one worst-case tree, so a rotation costs one refill. A 12k-
 * node tree folds a label and a value per node, so up to 24k keys. A smaller cap
 * rotated the map several times per `findAll` and doubled its cost.
 */
const FOLD_CACHE_MAX = 32_768;

/**
 * The same bound in CHARACTERS, because an entry is not a fixed size: the key
 * retains the ORIGINAL string and the JSDoc on {@link codepoints} cites an
 * 11,532-character label on a single card. Counting entries alone let the map
 * hold megabytes of dead originals for the lifetime of the server. Set so that
 * one worst-case tree of ordinary labels still fits a generation - 24k entries
 * of about 80 characters each, key and folded copy together - so this bound
 * binds only where the strings are long. About 8 MB of UTF-16 per generation.
 */
const FOLD_CACHE_MAX_CHARS = 4_000_000;

/**
 * The fold cache, in two generations. A lookup reads both and promotes a hit
 * from the old one, so a warm entry survives a wave of keys that never repeat.
 *
 * A single map cleared wholesale could not do that. A screen that emits more
 * distinct strings per poll than the cap — timestamped rows, a ticking relative
 * time — wiped every stable label beside them on every pass, and the next pass
 * refolded 24k strings cold. Rotating instead keeps the previous generation as
 * a second chance, so a string read once per pass is never evicted, and memory
 * stays bounded at two generations.
 */
let foldCacheYoung = new Map<string, string>();
let foldCacheOld = new Map<string, string>();
let foldCacheYoungChars = 0;
/** Strings actually folded, so a test can prove a warm entry stayed warm. */
let foldCacheMisses = 0;

function foldCacheGet(key: string): string | undefined {
  const young = foldCacheYoung.get(key);
  if (young !== undefined) return young;
  const old = foldCacheOld.get(key);
  // Promote, so the next rotation cannot drop a string this pass still reads.
  if (old !== undefined) foldCacheSet(key, old);
  return old;
}

function foldCacheSet(key: string, folded: string): void {
  foldCacheYoung.set(key, folded);
  foldCacheYoungChars += key.length + folded.length;
  if (foldCacheYoung.size >= FOLD_CACHE_MAX || foldCacheYoungChars >= FOLD_CACHE_MAX_CHARS) {
    foldCacheOld = foldCacheYoung;
    foldCacheYoung = new Map();
    foldCacheYoungChars = 0;
  }
}

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
 * {@link foldText} without the trim, on the LABEL side: leading and trailing
 * whitespace each survive as one space, which a substring test needs. A
 * boundary space is what an author writes to keep "Taps: 3" off "Taps: 30" -
 * it must match a real space in the label, so it is not an end-of-text anchor
 * and `equals` is the spelling that pins the end. A needle folds through
 * {@link foldPairLoose} instead, which keeps a break the author typed at its
 * edge.
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
 *
 * `bIsNeedle` marks `b` as the needle of a substring test, which folds its edge
 * whitespace faithfully. See {@link foldWith}.
 */
function foldPairLoose(a: string, b: string, bIsNeedle = false): [string, string] {
  const stripLtr = !isBidiSensitive(a) && !isBidiSensitive(b);
  return [foldWith(a, stripLtr), foldWith(b, stripLtr, bIsNeedle)];
}

/**
 * `edgeBreaks` decides what an edge whitespace run means. A LABEL's outer
 * whitespace is incidental — source indentation, a trailing newline — so it
 * collapses to one space. A NEEDLE's edge is an interior position of the label
 * it is tested against, so a break the author typed there stays a break; a
 * uniform "an edge is a space" rule made {@link includesCI} disagree with
 * itself, matching a one-line label and missing the two-line label the needle
 * was copied out of. A run that IS the whole string separates nothing either
 * way, so it stays a space and a whitespace-only needle keeps its loose meaning.
 */
function foldWith(value: string, stripLtr: boolean, edgeBreaks = false): string {
  const key = `${stripLtr ? "1" : "0"}${edgeBreaks ? "1" : "0"}${value}`;
  const hit = foldCacheGet(key);
  if (hit !== undefined) return hit;
  foldCacheMisses += 1;
  // Remove the invisibles before composition. An invisible between a base letter
  // and its combining mark blocks NFC, which leaves a decomposed grapheme.
  let stripped = value.replace(INVISIBLE, "");
  if (stripLtr) stripped = stripped.replace(LTR_BIDI, "");
  const folded = stripped
    .replace(SPACE_LIKE, " ")
    // One space per whitespace run, or one newline per line break in an
    // interior run. See {@link LINE_BREAKS_G} and `edgeBreaks` above.
    .replace(/\s+/g, (run: string, at: number, whole: string) => {
      const isWhole = run.length === whole.length;
      const isEdge = at === 0 || at + run.length === whole.length;
      if (isWhole || (isEdge && !edgeBreaks)) return " ";
      const breaks = run.match(LINE_BREAKS_G)?.length ?? 0;
      return breaks > 0 ? "\n".repeat(breaks) : " ";
    })
    .toLowerCase()
    // Compose last, because `toLowerCase` is not NFC-preserving. Where the
    // uppercase spelling has no precomposed code point, an NFC pass before the
    // case fold left one visibly identical pair unequal.
    .normalize("NFC");
  // Trees are re-read on every poll, so the same strings recur constantly.
  foldCacheSet(key, folded);
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
  // Folded as a pair, and with the needle marked as one, so this question and
  // {@link includesCI} agree about the LTR strip and about edge whitespace.
  const [hay, ndl] = foldPairLoose(haystack.normalize("NFKC"), needle.normalize("NFKC"), true);
  return hay.includes(ndl);
}

/**
 * True for a character that draws no glyph alone but builds one in sequence:
 * ZWNJ, ZWJ, every `Variation_Selector` block and the emoji tag characters. A
 * code-point predicate, because `no-misleading-character-class` bans the class.
 *
 * `Variation_Selector` is THREE blocks, not two: the Mongolian free variation
 * selectors sit beside U+180E, and each picks which glyph form of the preceding
 * Mongolian letter is drawn, so they belong here with VS1-16.
 */
function isSequenceBuilding(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0x180b && cp <= 0x180d) ||
    cp === 0x180f ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/** The directional controls: no glyph of their own, but they reorder text. */
const DIRECTIONAL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The two never-folded characters that draw no glyph but change which glyphs a
 * screen draws: U+00AD and U+180E. Both are `Default_Ignorable_Code_Point`, so
 * a note needs a separate lead for them rather than one about inert noise.
 */
const RENDERING_AFFECTING = /[\u00ad\u180e]/u;

/**
 * Every default-ignorable code point, with no exception: the sequence builders
 * and the two {@link RENDERING_AFFECTING} members are members too. Narrowing
 * the set is the job of the helpers below - {@link isInertIgnorable} drops the
 * sequence builders, and {@link ignorableDifferenceNote} gives U+00AD and
 * U+180E a lead of their own rather than calling them noise.
 *
 * The property, not `Cf`: `Cf` holds the concatenation marks and misses U+034F,
 * which is `Mn`.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The C0 controls and DEL. `Cc` is NOT `Default_Ignorable_Code_Point`, so
 * U+0000, U+001C-U+001F and DEL fell outside every question the notes ask, and
 * the failure reason quoted them into tool JSON as raw bytes. A copy-paste out
 * of a log or a PDF carries them, DEL is legal in HTML text, and the chromium
 * walker joins DOM text-node values with no `Cc` filter.
 *
 * Tab, the line breaks, the vertical tab and the form feed are `Cc` too, and
 * the fold already reads those as whitespace - {@link isFoldedWhitespace} takes
 * them back out. The property rather than a range, because a range has to spell
 * the control characters out and `no-control-regex` bans that.
 */
const CONTROL = /\p{Cc}/u;

/** {@link DEFAULT_IGNORABLE}, non-global - for a single-character test. */
const DEFAULT_IGNORABLE_ONE = new RegExp(DEFAULT_IGNORABLE.source, "u");

/** Whitespace, non-global - for a single-character test. */
const WHITESPACE_ONE = /\s/u;

/** True for whitespace the fold turns into a space or a line break. */
function isFoldedWhitespace(ch: string): boolean {
  return WHITESPACE_ONE.test(ch);
}

/**
 * Every character that draws nothing on its own: {@link DEFAULT_IGNORABLE} and
 * {@link CONTROL} together. Wider than what the helpers keep, so each of them
 * asks {@link isInertIgnorable} about a match rather than trusting the class.
 */
const UNDRAWN = new RegExp(`${DEFAULT_IGNORABLE.source}|${CONTROL.source}`, "gu");

/**
 * True for an undrawn character that builds no glyph in sequence. U+FEFF is
 * asked as a default-ignorable, not as whitespace: it is both, and only the
 * `Cc` branch defers to the fold.
 */
function isInertIgnorable(ch: string): boolean {
  if (isSequenceBuilding(ch)) return false;
  if (DEFAULT_IGNORABLE_ONE.test(ch)) return true;
  return CONTROL.test(ch) && !isFoldedWhitespace(ch);
}

/** Every inert ignorable in `text`, in order. */
function inertIgnorables(text: string): string[] {
  return (text.match(UNDRAWN) ?? []).filter(isInertIgnorable);
}

/**
 * `text` with every inert ignorable removed - roughly what the eye reads, and
 * the wide form the note's gate asks about. Only roughly, because U+00AD and
 * U+180E go too: a note that dropped them from its gate could not name them,
 * so they are removed here and then told apart by their own lead.
 */
function withoutInertIgnorables(text: string): string {
  return text.replace(UNDRAWN, (ch) => (isInertIgnorable(ch) ? "" : ch));
}

/** `text` with every inert ignorable removed except `keep`. */
function keepOnlyIgnorable(text: string, keep: string): string {
  return text.replace(UNDRAWN, (ch) => (isInertIgnorable(ch) && ch !== keep ? "" : ch));
}

/** Every inert ignorable in `text`, tagged with the count of visible characters before it. */
function placedIgnorables(text: string): string[] {
  const placed: string[] = [];
  let before = 0;
  for (const ch of text) {
    if (isInertIgnorable(ch)) {
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

/** {@link equalsCI}, allowing a compatibility variant. See {@link confusableTextNote}. */
const equalsOrVariantOf = (a: string, b: string): boolean =>
  equalsCI(a, b) || compatibilityVariantOf(a, b);

/** {@link includesCI}, allowing a compatibility variant. */
const includesOrVariantIn = (haystack: string, needle: string): boolean =>
  includesCI(haystack, needle) || compatibilityVariantIn(haystack, needle);

/**
 * A note that names the difference between two strings that look equal. Its
 * gate is wider than {@link foldText}: the comparator holds once every inert
 * default-ignorable is removed. It must not call a real rendering difference
 * invisible, so it excludes {@link isSequenceBuilding} characters and gives
 * {@link DIRECTIONAL} and {@link RENDERING_AFFECTING} their own leads.
 *
 * A typographic variant is allowed to sit beside the invisible one, and the
 * note then names both. This gate and {@link compatibilityVariantOf} used to
 * PARTITION the misses instead of composing: a never-folded invisible survives
 * NFKC and defeated the typographic question, while the rendered `…` remained
 * after the ignorables were gone and defeated this one. Hyphenation inserting a
 * soft hyphen and truncation inserting an ellipsis are plausible together, and
 * `Load<SHY>ing…` against `Loading...` was explained by neither note.
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
  const bareHolds = bareActual === bareExpected || equalsCI(bareActual, bareExpected);
  // Only when the ignorables are part of the answer. A pair the typographic
  // question already explains keeps its single note: a stray ZWSP beside a
  // ligature is absorbed by the fold and blocks nothing, so naming it would add
  // a code point the reader has no use for.
  const variant =
    !bareHolds &&
    !compatibilityVariantOf(actual, expected) &&
    compatibilityVariantOf(bareActual, bareExpected);
  if (!bareHolds && !variant) return undefined;
  // On the composed path the per-character necessity test has to allow the
  // variant too, or no single character is ever found to block and
  // {@link blockingIgnorables} falls back to naming them all.
  return ignorableDifferenceNote(
    actual,
    expected,
    variant ? equalsOrVariantOf : equalsCI,
    bareActual === bareExpected,
    variant
  );
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
function codepoints(chars: readonly string[], centre: number): string {
  if (chars.length <= CODEPOINT_DUMP_MAX) return chars.map(codepointName).join(" ");
  const start = Math.min(
    Math.max(0, centre - Math.floor(CODEPOINT_DUMP_MAX / 2)),
    chars.length - CODEPOINT_DUMP_MAX
  );
  const end = start + CODEPOINT_DUMP_MAX;
  const body = chars.slice(start, end).map(codepointName).join(" ");
  return `${start > 0 ? "\u2026 " : ""}${body}${end < chars.length ? " \u2026" : ""}`;
}

/** Characters before `index` that {@link inertIgnorables} does not collect. */
function visibleBefore(chars: readonly string[], index: number): number {
  let seen = 0;
  for (let i = 0; i < index; i += 1) if (!isInertIgnorable(chars[i])) seen += 1;
  return seen;
}

/** The index in `chars` that `count` visible characters reaches. */
function indexAfterVisible(chars: readonly string[], count: number): number {
  let seen = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (seen === count) return i;
    if (!isInertIgnorable(chars[i])) seen += 1;
  }
  return chars.length;
}

/**
 * The two strings as code points, windowed on the SAME region of both. Only
 * one side holds the blocking character - that is what makes it blocking - so
 * a per-string centre sent the other side back to index 0, and past
 * {@link CODEPOINT_DUMP_MAX} the two lists described different parts of the
 * label while the note's `actual [...] vs expected [...]` shape invites reading
 * them side by side. The side that lacks the character is centred on the same
 * position measured in VISIBLE characters, the count {@link placedIgnorables}
 * already tags an ignorable with.
 */
function codepointPair(
  actual: string,
  expected: string,
  blocking: readonly string[]
): [string, string] {
  const a = Array.from(actual);
  const e = Array.from(expected);
  const foundIn = (chars: readonly string[]): number =>
    chars.findIndex((ch) => blocking.includes(ch));
  let centreA = foundIn(a);
  let centreE = foundIn(e);
  if (centreA === -1 && centreE === -1) {
    centreA = 0;
    centreE = 0;
  } else if (centreA === -1) {
    centreA = indexAfterVisible(a, visibleBefore(e, centreE));
  } else if (centreE === -1) {
    centreE = indexAfterVisible(e, visibleBefore(a, centreA));
  }
  return [codepoints(a, centreA), codepoints(e, centreE)];
}

/**
 * What a compatibility variant is, and why the fold keeps those apart. Shared,
 * so this note and the clause {@link ignorableDifferenceNote} appends when a
 * variant stands beside an invisible character cannot drift.
 */
const VARIANT_BODY =
  `variant (a rendered "…" is ONE character, not three dots; likewise ligatures and ` +
  `fullwidth forms). Those are not folded together, because doing so would also equate a ` +
  `styled display name with the plain one it imitates. Copy the text exactly as this ` +
  `message quotes it.`;

/**
 * The shared body of the two confusable notes: pick the lead that names the
 * characters that differ, then print both strings as code points. A reorder
 * wins a mixed difference, and only the last branch says "invisible". `holds`
 * is the comparator {@link blockingIgnorables} asks.
 *
 * The word "only" is conditional, because the gate is: it accepts a pair whose
 * remainders are merely COMPARATOR-equal, so a difference of case, of spacing
 * or of composition can sit beside the invisible one. The dumps print that
 * difference — `U+0048` against `U+0068` for `Home<CGJ>` against `home` — and a
 * lead claiming the strings differ ONLY in invisible characters reads as false
 * against the two lists directly beneath it. `restIdentical` comes from the
 * caller, because the question is the caller's relation asked without the fold:
 * equality for one note, "appears in" for the substring one.
 */
function ignorableDifferenceNote(
  actual: string,
  expected: string,
  holds: (a: string, b: string) => boolean,
  restIdentical: boolean,
  alsoVariant: boolean
): string | undefined {
  const differing = blockingIgnorables(actual, expected, holds);
  if (differing.length === 0) return undefined;
  const only = restIdentical ? "only " : "";
  const lead = differing.some((ch) => DIRECTIONAL.test(ch))
    ? `the two strings differ ${only}in directional formatting, which draws nothing itself but ` +
      "REORDERS the characters around it, so the screen does not read the way the text does"
    : differing.some((ch) => RENDERING_AFFECTING.test(ch))
      ? "the two strings differ in a character that draws nothing itself but changes what IS " +
        "drawn — a soft hyphen paints a real hyphen where the line breaks, U+180E breaks " +
        "Arabic cursive joining as ZWNJ does — so this is a real difference, not one the " +
        "comparison can ignore"
      : `the two strings differ ${only}in invisible characters`;
  const [dumpActual, dumpExpected] = codepointPair(actual, expected, differing);
  // The second cause, when the pair carries one. The exact code points come
  // first, because they are the more precise half.
  const variant = alsoVariant ? ` — the two also differ by a typographic ${VARIANT_BODY}` : "";
  // What is left, when the variant clause is not already the account of it.
  const rest =
    restIdentical || alsoVariant
      ? ""
      : " — what is left differs in case, spacing or composition, which the comparison folds together";
  return `${lead} — actual [${dumpActual}] vs expected [${dumpExpected}]${rest}${variant}`;
}

/**
 * The substring form of {@link confusableTextNote}: the needle failed to appear
 * in the label because of inert ignorable characters, and possibly a
 * compatibility variant with them. Both strings print whole, not as the matched
 * region, because an index cannot map back.
 */
export function confusableTextNoteIn(haystack: string, needle: string): string | undefined {
  if (includesCI(haystack, needle)) return undefined;
  const bareHaystack = withoutInertIgnorables(haystack);
  const bareNeedle = withoutInertIgnorables(needle);
  const bareHolds = includesCI(bareHaystack, bareNeedle);
  // See {@link confusableTextNote}: a miss the typographic question answers on
  // its own does not gain a codepoint list.
  const variant =
    !bareHolds &&
    !compatibilityVariantIn(haystack, needle) &&
    compatibilityVariantIn(bareHaystack, bareNeedle);
  if (!bareHolds && !variant) return undefined;
  return ignorableDifferenceNote(
    haystack,
    needle,
    variant ? includesOrVariantIn : includesCI,
    bareHaystack.includes(bareNeedle),
    variant
  );
}

/**
 * Screen text, made safe for a failure message. A label with an unbalanced
 * U+202E survives the fold, and quoted as it stands it reverses every character
 * after it. A {@link CONTROL} member is worse than confusing:
 * quoted raw it puts a NUL or an ESC into the tool's JSON reply and into the
 * log line beside it. Replace both classes with names, and keep the rest.
 *
 * An {@link LTR_BIDI} control the fold STRIPS is dropped instead of named. It
 * reorders nothing there, the comparison never saw it, and naming it printed
 * eight characters of ASCII the screen does not draw — directly above a
 * sentence telling the reader to copy what it does draw. Copying the named
 * form then missed a second time, with nothing to explain it. A control
 * character is not in that position: nothing folds it away, so the reader has
 * to see it and take it out.
 */
export function quoteScreenText(text: string): string {
  // Same question the fold asks. A bidi-sensitive string keeps its LTR
  // controls, so there they are named like the rest.
  const keepsLtr = isBidiSensitive(text);
  return text.replace(QUOTE_UNSAFE_G, (ch) => {
    // A tab or a line break prints as itself: the fold reads it as whitespace,
    // so naming it would print ASCII the comparison does not want back.
    if (isFoldedWhitespace(ch)) return ch;
    return !keepsLtr && LTR_BIDI_ONE.test(ch) ? "" : `<${codepointName(ch)}>`;
  });
}

/** What {@link quoteScreenText} must not print as it stands. */
const QUOTE_UNSAFE_G = new RegExp(`${DIRECTIONAL.source}|${CONTROL.source}`, "gu");

/**
 * A note that names the invisible characters in one string, with no comparison.
 * {@link confusableTextNote} cannot serve a `matches` step, because its
 * "expected" is a regex, and `matches` is exempt from the fold. `pattern` says
 * only whether the author already spelled those characters out.
 *
 * It deliberately does NOT re-run the pattern on the stripped text. An author's
 * regular expression is untrusted, and stripping is exactly what unblocks it:
 * when an ignorable stops an anchored pattern the real comparison dies in O(1),
 * because the engine never enters the quantifier, while the same pattern on the
 * stripped label backtracks. Measured with `^(A+)+b$` against a leading U+200B
 * and 28 "A"s: the comparison took 0.015 ms and the re-test 1,005 ms, growing
 * fourfold per two characters, and it returned no note either way. Node's
 * engine is not interruptible and this server is single-threaded, so neither
 * the step timeout nor the abort signal can stop it.
 *
 * So the note states a fact about the text instead of diagnosing the miss. That
 * is the more useful sentence anyway: a pattern corrected for some OTHER reason
 * still has to account for these characters on the next run.
 */
export function ignorableTextNote(text: string, pattern?: string): string | undefined {
  const found = inertIgnorables(text);
  if (found.length === 0) return undefined;
  // Nothing to point out when the pattern already carries every one of them.
  if (pattern !== undefined && found.every((ch) => pattern.includes(ch))) return undefined;
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
    `${lead} — a regular expression is deliberately never folded, so a pattern has to match ` +
    `them literally`
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
 *
 * "the ELEMENT's text", never "the screen shows": `label` is the accessibility
 * name on every adapter that feeds this - `aria-label` on chromium, the
 * content-desc on Android, `accessibilityLabel` on iOS - so on an icon-only
 * control it is the node's only text and the screen draws none of it. The
 * quoted string is still exactly what to copy.
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
    if (note !== undefined) return `the element's text is "${quoteScreenText(text)}" — ${note}`;
  }
  for (const text of texts) {
    if (compatibilityVariantIn(text, wanted)) return typographicVariantNote(text);
  }
  return undefined;
}

/**
 * The sentence that names a compatibility variant in an element's text. Shared
 * by its two callers, so a selector miss and a `text` miss cannot drift apart.
 * Says "the element's text" for the reason {@link selectorMissNote} gives.
 *
 * `shown` is omitted by the caller that has ALREADY quoted the string one
 * clause earlier. Nothing bounds this quote the way {@link CODEPOINT_DUMP_MAX}
 * bounds the dumps beside it, and `assertText` prefers the hoisted
 * `subtreeText`, so on a container assertion re-printing it carried three
 * thousand characters of one card twice in a single failure reason.
 */
export function typographicVariantNote(shown?: string): string {
  const lead =
    shown === undefined
      ? `the two strings above differ only by a typographic`
      : `the element's text is "${quoteScreenText(shown)}", which differs only by a typographic`;
  return `${lead} ${VARIANT_BODY}`;
}

export function includesCI(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  // Both sides untrimmed, so a boundary space still constrains the match (see
  // {@link foldLoose}), and folded as a pair so a needle copied from the label
  // stays a substring of it (see {@link foldPairLoose}).
  const [hay, ndl] = foldPairLoose(haystack, needle, true);
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
 * Case-insensitive EXACT match, or the unqualified name of an Android
 * resource-id (`submit` matches `com.example.app:id/submit`), so a caller never
 * needs the package prefix. Deliberately not a substring test: a short needle
 * would capture unrelated ids (`save` must not match `autosave-banner`).
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

/** @internal Seam for asserting regex compilation lifetime in tests. */
export const uiTreeMatchInternals = {
  createRegExp(pattern: string): RegExp {
    return new RegExp(pattern);
  },
  /** How many folds are cached right now - for pinning {@link FOLD_CACHE_MAX}. */
  foldCacheSize(): number {
    return foldCacheYoung.size + foldCacheOld.size;
  },
  /** How many strings have been folded rather than read from the cache. */
  foldCacheMisses(): number {
    return foldCacheMisses;
  },
};

// Absent/empty text is never a regex haystack, matching `includesCI`.
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
  // Patterns are validated at flow parse time, so construction cannot throw.
  if (mode === "matches") {
    return regexMatchesNonEmpty(uiTreeMatchInternals.createRegExp(expected), actual);
  }
  return mode === "equals" ? equalsCI(actual, expected) : includesCI(actual, expected);
}

/**
 * Does the selector constrain WHICH element it matches, rather than only where
 * to look? False exactly for the universal selector (flow YAML's `any: true`).
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
 * Single-node predicate over the selector's OWN fields. The relational scopes
 * need the tree and are resolved by {@link findAll}; they are ignored here.
 *
 * A selector with no own fields matches EVERY node — the universal selector
 * (CSS `*`, `any: true` in flow YAML), which `selectorSchema` and the flow
 * parser only admit behind an explicit `any: true` paired with a relation.
 */
export function matchNode(node: DescribeNode, selector: Selector): boolean {
  return matchNodeWithRegex(node, selector, selectorTextRegex(selector));
}

// Frame-comparison tolerance (normalized units): a hair of overhang — a border,
// a shadow, sub-pixel rounding — must not change what the eye plainly sees.
// `frameWithin` reads it as containment slack; `frameAbove` reads it as the
// row-band merge threshold. Same magnitude as flow-actions' EDGE_EPS.
const WITHIN_EPS = 0.005;

/** Is `inner` contained in `outer`, within {@link WITHIN_EPS} per edge? */
export function frameWithin(inner: DescribeFrame, outer: DescribeFrame): boolean {
  return (
    inner.x >= outer.x - WITHIN_EPS &&
    inner.y >= outer.y - WITHIN_EPS &&
    inner.x + inner.width <= outer.x + outer.width + WITHIN_EPS &&
    inner.y + inner.height <= outer.y + outer.height + WITHIN_EPS
  );
}

// A naive `within` scan tests every candidate against every container, which a
// broad container selector (`within: { role: <common role> }`) drives quadratic
// on a flow tree of up to 12k nodes — and findAll re-runs on every settle/poll.
// Above a small container count, index the containers in a coarse uniform grid
// so a candidate only tests the containers registered in its own top-left cell.
// Only a `within` selector ever builds this.
const CONTAINMENT_GRID_N = 16; // cells per axis over the normalized [0,1]² frame
const CONTAINMENT_GRID_MIN = 32; // fewer containers than this: a direct scan wins

// The grid column/row a normalized coordinate falls in, clamped to [0, N):
// a frame can sit a hair off-screen and must still map to a real cell.
function gridCell(coord: number): number {
  const c = Math.floor(coord * CONTAINMENT_GRID_N);
  return c < 0 ? 0 : c >= CONTAINMENT_GRID_N ? CONTAINMENT_GRID_N - 1 : c;
}

/**
 * Build a predicate `inside(node)` — true when the node's frame sits inside a
 * DISTINCT container in `containers`. Below {@link CONTAINMENT_GRID_MIN} it
 * scans directly; larger sets are indexed in a coarse grid keyed by top-left
 * cell.
 *
 * A container is registered in every cell its frame covers, PADDED by
 * {@link WITHIN_EPS}: a candidate may overhang a container edge by up to the
 * tolerance, so its top-left corner can land one cell before the container's
 * unpadded coverage. The grid only PRUNES — the exact `frameWithin` check on
 * the bucket decides — so the padding never admits a false containment.
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

/**
 * Is `a` entirely above `b`, within {@link WITHIN_EPS}? The vertical half of
 * reading order. Frames for which this fails BOTH ways share a row band and are
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
 * so the follower test and the grouping of followers can never disagree.
 *
 * A mutual verdict on either axis never decides: frames thinner than the
 * tolerance and closer together than it read as ordered BOTH ways, which would
 * otherwise let an element to the anchor's LEFT follow it. Vertically such a
 * pair falls through to the row rule; horizontally it means no order at all.
 * The relation is therefore antisymmetric, which the `next` reduction relies on.
 *
 * Mostly not a containment test, but a child flush with the anchor's bottom or
 * right edge and no thicker than the tolerance (a hairline divider) both
 * follows the anchor and sits {@link frameWithin} it.
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
 * index buys nothing here — the pruning it could offer is already subsumed by
 * the `some` short-circuit on the first matching anchor.
 */
function afterTester(anchors: DescribeNode[]): (node: DescribeNode) => boolean {
  return (node) => anchors.some((a) => a !== node && frameAfter(node.frame, a.frame));
}

// Ranking among an anchor's followers. Position first, then frame AREA so that
// coincident top-left corners — a container and the label leaf flush inside it,
// an everyday flattened-tree shape — resolve to the smaller, more specific
// element (the "smallest frame wins" doctrine `selectorToFrame` and
// `nodeAtPoint` rank by), then the individual extents, which separate shapes
// equal area cannot. Only frames identical on all four fields fall back to tree
// order, and those are indistinguishable to act on anyway.
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
 * unioned over anchors, returned in the candidates' own order.
 *
 * "Nearest" splits the followers the way a reader does: one sharing the
 * anchor's row band beats anything on the rows below, because that is the row's
 * own control — the locator `next` exists for. Within each group the leftmost
 * (band) / topmost (below) wins, then the smaller frame.
 *
 * A direct scan per anchor: unlike {@link afterTester} it cannot short-circuit,
 * but the index this replaced was a second implementation of the rules above
 * and the two disagreed on frames near the tolerance. The quadratic tail only
 * bites when the anchor selector matches essentially every node.
 *
 * The pick is made over ALL candidates, visible or not — it reduces the match
 * SET before any condition looks at it. Where the flow adapter keeps zero-area
 * nodes (Vega), a ghost node between the anchor and the real control therefore
 * wins the pick and a `visible` check on it fails — scope by
 * {@link Selector.after} or {@link Selector.within} there instead.
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

// Every node matching the selector, EXCLUDING `root` — the synthetic
// full-screen container at the head of a describe tree. Matching it would let a
// broad role selector satisfy `visible`/`exists` on any screen, and would make
// `within` vacuous since the root wraps everything.
//
// Every relation requires a DISTINCT node (`a within a` needs two nested
// elements), and each nests: `within: { id: b, within: c }` resolves c's
// containers first, then keeps only the b's sitting inside one of them.
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
 * {@link resolveSelector} applies them. Shared with flow YAML's parser,
 * serializer and loose-alternative expansion so the layers cannot drift on
 * which keys are relations.
 */
export const SELECTOR_RELATIONS = ["within", "after", "next"] as const;

export type SelectorRelation = (typeof SELECTOR_RELATIONS)[number];

/**
 * How each scope narrows a match set. `within` and `after` are per-node
 * predicates; `next` reduces the SET, which is why the order above applies it
 * last — `{ any: true, next: X, within: Y }` means "the first element inside Y
 * that follows X", not "the first element after X, if it is inside Y".
 *
 * Keyed by the relation union, so adding a scope without teaching the engine
 * what it means is a compile error rather than a silently ignored constraint.
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

// describe prunes off-screen nodes, so a non-zero frame area stands in for
// "visible".
export function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The element a reader "sees first": smallest (y, then x), matching the order
// format-tree renders flat iOS leaves in.
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

// Evaluated over ALL elements matching a selector. `visible` holds if ANY match
// is on-screen; `hidden` only if NONE is; `text` reads the first VISIBLE match
// in reading order (the first overall if none is visible), so a stale zero-area
// node can't shadow the element the check meant to read, and the failure
// messages (flow assertReason, await-ui-element's timeout note) quote the same
// node.
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
      // Hoisted subtree text is ADDITIVE: a check the element's own
      // label/value satisfies on a plain describe tree must not start failing
      // because the flow adapters stamped a compound `subtreeText` on the node.
      return (
        textMatches(assertText(first), expectedText, textMatch) ||
        textMatches(nodeText(first), expectedText, textMatch)
      );
    }
    default:
      return false;
  }
}

/**
 * A fingerprint of the tree's structure — every node's role, rounded frame and
 * text/identifier. Two consecutive identical fingerprints mean the UI has
 * settled: the flow runner waits out a fling before tapping, so a tap can't
 * land mid-deceleration (a scroll view would swallow it to halt the scroll) and
 * a resolved frame can't already be stale. Frames are rounded so sub-pixel
 * jitter does not read as motion.
 *
 * The optional `include` predicate restricts the fingerprint to a subset of
 * nodes (children of an excluded node are still walked) — the end-of-scroll
 * check fingerprints only the scrolled region, so an animating node elsewhere
 * can't keep the fingerprint changing and mask the end of the scroll.
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

export function frameContains(frame: DescribeFrame, x: number, y: number): boolean {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function frameArea(frame: DescribeFrame): number {
  return frame.width * frame.height;
}

/**
 * Reverse lookup for recording: the smallest visible node whose frame contains
 * the tapped point — the most specific element (a button over its container).
 * Skips the synthetic root.
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

// Does the regex consume the WHOLE non-empty string? The regex analog of an
// exact text match, for ranking: a full hit on a leaf must beat a container
// whose aggregated label merely contains the same text. The `(?:…)` wrapper is
// non-capturing, so backreference numbering is unchanged.
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
 * The on-screen frame of a selector's best visible match — what a `tap`/`type`
 * action targets. An accessible container (e.g. a Touchable on iOS) aggregates
 * its descendants' labels, so a substring text selector matches the container
 * as well as the leaf carrying the text, and the container's centre can sit
 * over a different child entirely. Matches are therefore ranked by the graded
 * score {@link exactFieldCount} sums: a field matching the WHOLE text beats one
 * that merely contains the needle, and among whole-text matches the LITERAL
 * spelling beats one only the fold equates. A tie in that score falls to the
 * smallest frame (mirroring {@link nodeAtPoint}), with reading order as the
 * final tiebreak.
 *
 * The grade is what the smallest-frame rule must not decide, so read the two in
 * that order: an icon-only 28x28 button labelled `Sign<LRM> in` and the real
 * 420x70 one are both exact under the fold, and "smallest wins" would take the
 * icon.
 *
 * The universal selector (flow YAML's `any: true`) is the case ranking cannot
 * serve: with no field to be exact about, "smallest" degenerates to whatever
 * hairline spacer the scope contains. A field-less selector names a REGION, so
 * its matches are read the way conditions read a match set — first in reading
 * order — keeping an action's target the element an `assert` would quote.
 *
 * {@link compareBelowPick} rather than {@link firstInReadingOrder}: both order
 * by (y, x), but a bare reading order leaves an exact positional tie to adapter
 * emission order, and two frames with different extents are two different tap
 * centres, so the tie continues into "most specific" instead.
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

export const GENERIC_ROLES = new Set([
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

/**
 * A POSITIONAL id — `profilePager-selector-2`, `tab-selector-0`. The number is
 * the element's index among its siblings, so the id names a slot rather than a
 * thing: it survives no re-order and silently addresses a different control
 * once one is inserted before it. Recording one only ever produced a fragile
 * step that looked strict — one an author has to notice and replace by hand.
 *
 * It matters most where the recorder is least reliable. The flow tree is
 * flattened and carries no z-order, so a tap inside a full-screen modal can
 * resolve against a view BEHIND it; observed on Bluesky's edit-profile sheet,
 * where a tap on the display-name field derived the profile pager's "Media"
 * tab. An ambiguous or oversized background match is already caught and warned
 * about, but a positional id on a background node passes every one of those
 * checks and records silently. Refusing it turns that case back into the
 * kept-coordinate warning the author is told to act on.
 */
const POSITIONAL_ID = /-selector-\d+$/i;

/**
 * The most stable selector identifying a node, used by the recorder to turn a
 * tapped element into a `tap: { selector }` step. Prefers identifier — unless it
 * is positional, see {@link POSITIONAL_ID} — then text, then a non-generic role.
 * Null when the node has nothing stable to match on — the caller then keeps
 * coordinates.
 */
export function deriveSelector(node: DescribeNode): Selector | null {
  const id = node.identifier?.trim();
  if (id && !POSITIONAL_ID.test(id)) return { identifier: node.identifier! };
  // Label OR value individually — never nodeText's joined form: matchNode
  // compares a text selector against label and value separately, so a joined
  // "Volume 50%" would match nothing, not even the node it came from. Label
  // first: a value like "50%" is the volatile part of a control. Icon-font
  // labels are invisible in YAML (see hasVisibleText), so a node carrying only
  // those falls through to role/coordinates.
  const text = [node.label, node.value].map((t) => t?.trim()).find((t) => t && hasVisibleText(t));
  if (text) return { text };
  if (node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) return { role: node.role };
  return null;
}

/**
 * Fetch the describe tree for a device. The chromium CDP session is the only
 * service resolved here — iOS / Android describe resolve their own internally,
 * and Vega reads the on-device automation toolkit's page source.
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
