import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../../blueprints/android-devtools";
import {
  attrIsTrue,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
} from "../../describe/platforms/android/uiautomator-parser";
import {
  injectAndroidKeycodeRepeated,
  injectAndroidText,
  ANDROID_NAMED_KEYCODES,
} from "../../../utils/android-input";
import type { KeyboardVerification } from "../types";

/**
 * Read-back verification for the Android phone / tablet typing path.
 *
 * `adb shell input text` converts the string to KeyEvents through the virtual
 * KeyCharacterMap and injects them back-to-back with no cadence. A field whose
 * owner re-renders per keystroke — a controlled React Native `TextInput`, a
 * search box that re-queries on every change — drops events out of that burst,
 * and the transport gives no signal that it happened: `adb` exits 0 having
 * "typed" the whole string. Reproduced on a Pixel 6 / API 34 emulator against
 * the Settings search box: one `input text` of a 76-character sentence landed
 * 45 characters ("The quick brown fox jumps over the lazy dog. ") and the tool
 * reported full success. The same sentence injected in 8-character chunks
 * landed all 76.
 *
 * So the only way to know what a `keyboard` call actually did is to look: read
 * the focused field before injecting, read it again after, and compare. Only
 * this backend does it. The iOS / Chromium / Vega transports synthesise no
 * KeyEvent burst through a KeyCharacterMap and are not exposed to the failure at
 * all. Android TV IS exposed — `blueprints/android-tv-control.ts` reaches the
 * same `injectAndroidText` — but it types one space-free word per call, and its
 * backend is shared with Apple TV, whose describe reports a focused element with
 * no identity to match it by: see the scoping comment in `tv.ts`.
 *
 * Cost, and why it is not gated on anything. A call that verifies and needs no
 * repair costs TWO `getHierarchy` calls over the helper's already-open socket,
 * each a wait for the screen to go quiet, bounded at 500 ms, plus the tree walk:
 * measured on the same emulator, screen
 * and string, typing 76 characters into the Settings search box costs 1.6-1.8 s
 * unverified and 1.9-3.4 s verified. A call that REPAIRS costs a third
 * `getHierarchy` plus the repair itself, which then dominates everything else:
 * `ceil(len / REPAIR_CHUNK_CHARS)` `input text` calls and
 * `ceil(deletions / DELETE_KEYCODES_PER_CALL)` `input keyevent` calls, each
 * paying its own `app_process` spawn, plus the inter-chunk pauses — 29 adb calls
 * for a 200-character repair and 85 for a 600-character one, which at the
 * ~200-400 ms per call quoted on `REPAIR_CHUNK_CHARS` plus 100 ms between chunks
 * is 8-14 s and 24-41 s respectively. The tool declares `longRunning` for that reason: past ~30 s the
 * MCP adapter would abandon the request and replay it, and this tool is not
 * idempotent (see `../index.ts`).
 *
 * The FIRST typed string on a device also pays for the helper itself — an
 * `adb install -t` of the helper APK, which runs before the spawn and on its own
 * budget rather than inside that blueprint's 30 s READY timeout, plus an
 * `am instrument` spawn which is what that timeout bounds — measured at 6.1 s
 * including the install and 1.8 s when only the spawn was needed. It is the same
 * helper `describe` resolves, so an agent that has described this device has
 * already paid it.
 *
 * That is real latency on a hot path (the flow `type` directive routes through
 * this tool), and it is still the right default, because the corruption is a
 * property of the *field*, not of the text: QA saw one sentence land perfectly in
 * one field and corrupt in another on the same screen at the same moment, and a
 * field that re-renders per keystroke can lose a single character. A length
 * threshold or an opt-in flag would make the guarantee depend on a magic number
 * and leave the silent-success bug reachable on everything under it. What IS
 * gated is the transport: when the android-devtools helper cannot be resolved,
 * the only remaining read-back is `uiautomator dump`, a fresh shell-out with no
 * persistent connection to amortise — so verification is skipped and said to be
 * skipped, rather than charging a locked-down device (exactly the device where
 * `adb install -t` is blocked) two dumps per typed string.
 *
 * No read passes `waitForIdleMs`, so each takes the blueprint's 500 ms settle.
 * Overriding the "before" read to 0 would save that, but it runs right
 * after the agent's own tap on the field, and reading before the framework has
 * published `focused="true"` turns a healthy call into a spurious "no editable
 * field had focus" note.
 */

/**
 * Classes whose focused instance receives the KeyEvents `input text` generates.
 * `EditText` covers React Native `TextInput`, Compose `TextField` (the
 * semantics delegate reports `android.widget.EditText`) and WebView inputs;
 * `AutoComplete` catches the `EditText` subclasses whose simple name does not
 * contain "EditText" (`AutoCompleteTextView`, `SearchView$SearchAutoComplete`).
 *
 * Broader than the `/EditText/` probe in `blueprints/android-tv-control.ts`
 * deliberately: there the verdict only labels an element `textfield` for the
 * agent to read, while here it decides whether a correctness check runs at all,
 * so a missed subclass would silently disable verification.
 */
const EDITABLE_CLASS_RE = /EditText|AutoComplete/;

// Derived from the shared keycode map rather than re-hardcoded, so the undo
// deletes with the same key the tool's own `key: "backspace"` presses.
const KEYCODE_BACKSPACE = ANDROID_NAMED_KEYCODES.backspace;

/**
 * Re-injection cadence for the repair. Empirically the whole point: 8-character
 * chunks with a pause between them landed a 76-character sentence in full on a
 * field where a single `input text` call landed 45 characters. The dominant gap
 * is actually the per-call `app_process` spawn `input` pays (~200-400 ms); the
 * explicit delay makes the cadence independent of how fast adb happens to be.
 */
const REPAIR_CHUNK_CHARS = 8;
const REPAIR_CHUNK_DELAY_MS = 100;

/**
 * `input keyevent` accepts several keycodes per call and injects them from one
 * `app_process` boot, so the undo runs as a handful of calls instead of one per
 * character. Capped so the device-side command line stays short.
 */
const DELETE_KEYCODES_PER_CALL = 64;

// Half the helper's own 60 s socket read timeout, so one missed tick still
// leaves the connection open.
const DEVTOOLS_KEEPALIVE_MS = 30_000;

interface FocusedField {
  /**
   * The field's `text` as the accessibility tree reports it. NOTE: for an empty
   * `EditText` with a hint this is the HINT, not "" — `TextView`'s
   * `getTextForAccessibility()` falls back to the hint, confirmed on API 34
   * (the empty Settings search box reports `text="Search settings"`). So this is
   * not "the field's content" and the comparison cannot treat it as such — see
   * `classifyTypedText`, which accepts a hint baseline as a successful replace
   * and refuses to draw any conclusion when the two readings are ambiguous.
   */
  text: string;
  /**
   * The field's `resource-id`, and the empty string when it has none. See
   * `isSameField` for how the identity attributes are weighed.
   */
  resourceId: string;
  /**
   * Whether the `resource-id` fails to identify this field: another editable view
   * in the same capture carries it, which makes it a layout id, or the capture was
   * truncated and cannot show that it is unique. Only read for a field that has an
   * id at all. See `isSameField`.
   */
  idShared: boolean;
  /** The field's `class`. See `isSameField`. */
  className: string;
  /** The field's bounds, or null when they do not parse. See `isSameField`. */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /**
   * Whether the focused field masks its input. Two independent reasons to skip
   * the read-back rather than one:
   *
   *  - It could not work. A password field reports bullets, not characters —
   *    measured through the helper on API 34, an `EditText` holding
   *    `SecretPass1` reads back `text="•••••••••••"` — so every comparison would
   *    fail and every credential would be reported `verified: false`.
   *  - It must not be relied on to work. That masking is the platform's default,
   *    not a guarantee this code can enforce, which is why
   *    `uiautomator-parser.ts` and `flows/flow-android-tree.ts` redact the
   *    attribute rather than trusting it. Comparing a credential we read back
   *    would put the plaintext one refactor away from the result, against this
   *    tool's whole `{{secret:…}}` contract.
   */
  password: boolean;
}

/**
 * What holds input focus in a uiautomator-schema hierarchy.
 *
 * `field` is the focused view this check can read back; `focusedClass` is the
 * class of the FIRST focused view of any kind, which is what separates "nothing
 * has focus" from "something has focus that `EDITABLE_CLASS_RE` does not cover".
 * They need different notes: the advice for the first is "tap the field", which
 * for the second is advice for a screen this is not.
 *
 * Walked in document order and takes the first match: a capture spanning several
 * windows (the helper walks every interactive window it is given — see
 * `captureMode` / `windowCount` on `HierarchyResult`) can carry a stale
 * `focused="true"` in a background window behind the one actually taking input.
 */
function findFocused(xml: string): { field: FocusedField | null; focusedClass: string | null } {
  const root = parseUiAutomatorXml(xml);
  if (!root) return { field: null, focusedClass: null };
  const stack = [root];
  let focusedClass: string | null = null;
  let field: FocusedField | null = null;
  // Counted over the whole capture, not stopped at the field: an id several
  // editable views share is a layout id, which `isSameField` must not trust.
  const idCounts = new Map<string, number>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    // Push children in reverse so they pop back in document order.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    const attrs = node.attrs;
    const className = attrs.class ?? "";
    const editable = EDITABLE_CLASS_RE.test(className);
    const resourceId = attrs["resource-id"] ?? "";
    if (editable && resourceId !== "")
      idCounts.set(resourceId, (idCounts.get(resourceId) ?? 0) + 1);
    if (field !== null || !attrIsTrue(attrs, "focused")) continue;
    if (focusedClass === null) focusedClass = className;
    if (!editable) continue;
    const rect = parseUiAutomatorBounds(attrs.bounds ?? "");
    field = {
      text: attrs.text ?? "",
      resourceId,
      className,
      bounds: rect,
      password: attrIsTrue(attrs, "password"),
      idShared: false,
    };
  }
  if (field !== null) field.idShared = (idCounts.get(field.resourceId) ?? 0) > 1;
  return { field, focusedClass };
}

/** The focused editable view, or null when none of the focused views is one. */
export function findFocusedTextField(xml: string): FocusedField | null {
  return findFocused(xml).field;
}

/**
 * Whether the after-read is looking at the field the text was typed into.
 *
 * The point is to catch focus moving to a DIFFERENT field between the two reads
 * — an auto-advancing form (an OTP code split across boxes, a field that jumps
 * on maxLength) does exactly that, and comparing one field's baseline against
 * another's text would have the repair retype into a field the caller never
 * targeted.
 *
 * A different widget class is a different field and settles it first. Past that
 * the two discriminators are not equally good, so they are weighed rather than
 * concatenated. A `resource-id` no other editable view in the capture carries
 * settles it on its own: it is the Android view id, carrying the React Native
 * `testID` (see `flows/flow-android-tree.ts`), and it does not change when the
 * field moves. An id is NOT an identity when the capture holds several editable
 * views behind it: `getViewIdResourceName` reports the id of the layout, so six
 * `<include>`d or recycled OTP boxes all read `…:id/otp_digit`. Matching on that
 * alone passes box 2 off as box 1 in an auto-advancing form, which puts the
 * repair's backspaces and retype into the box the caller never targeted and
 * reports it verified. Position is the fallback for those and for a field with no
 * id at all — every untagged `TextInput` and Compose `TextField` dumps
 * `resource-id=""`.
 *
 * Position is a fallback and not the primary because typing MOVES fields: it is
 * an OVERLAP test rather than an equality one, the same predicate and the same
 * reason as `flows/flow-actions.ts`'s `framesOverlap` ("keyboard avoidance
 * routinely scrolls the field away from where it was tapped"). Typing into the
 * Settings search box moved its right edge from 1080 to 933 (measured, API 34)
 * and a bottom-anchored chat composer grows UPWARD as its text wraps, and both
 * still cover their old rectangle; two boxes of a form never cover each other's.
 * A field that moves clear of where it was — a list scrolled by more than a row —
 * reads as a focus change, which declines the repair and reports the field as
 * unmatched rather than as verified.
 *
 * Known limitation: duplicate ids are only visible where the capture holds both
 * views. Two screens, or two pages of a pager, that reuse one layout show one
 * view each, so nothing marks the id as shared and the position test never runs.
 */
function isSameField(a: FocusedField, b: FocusedField): boolean {
  if (a.className !== b.className) return false;
  if (a.resourceId !== b.resourceId) return false;
  if (a.resourceId !== "" && !a.idShared && !b.idShared) return true;
  return boundsOverlap(a.bounds, b.bounds);
}

/** Whether two parsed bounds share any pixel. Unparseable bounds identify nothing. */
function boundsOverlap(a: FocusedField["bounds"], b: FocusedField["bounds"]): boolean {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * What the before/after pair says about the injection.
 *
 * `indeterminate` is not hedging: two different events can leave the field in
 * byte-identical states, and acting on a guess is worse than saying so. Typing
 * "argent" into a `selectAllOnFocus` field that already reads "argent" succeeds
 * and changes nothing; typing it into the same field and having every key event
 * dropped also changes nothing. Retyping on that evidence enters the text twice.
 */
type TypedTextVerdict = "landed" | "not-landed" | "indeterminate";

/**
 * Whether every character of `before` is still present in `after` as a single
 * run split by one inserted block — i.e. the prior content survived and this was
 * an insertion into it, not a replacement of it.
 */
function beforeSurvived(before: string, after: string): boolean {
  return (
    after.length >= before.length && coversByEdges(before, after, after.length - before.length)
  );
}

/**
 * Classify the injection from the field's text before and after it.
 *
 * Accepting shapes, each broken by a dropped keystroke:
 *
 *  - *inserted*: `text` appears contiguously and the field grew by exactly
 *    `text.length`. Holds wherever the cursor sat and whatever the field already
 *    contained. A dropped character breaks the contiguous-substring half; a
 *    doubled injection breaks the length half.
 *  - *replaced*: the field now holds precisely `text` and the prior content did
 *    NOT survive into it — which an unchanged field cannot satisfy, since
 *    `before` always survives into itself. That is the empty-field case —
 *    the baseline read was the hint (see `FocusedField.text`) — and equally a
 *    selection that `input text` replaced.
 *
 * Ambiguous shapes, reported as `indeterminate` and never repaired. Every one of
 * them is a reading that BOTH a correct injection and a partial landing produce,
 * so the repair — which would delete and retype on top of a field that may
 * already be right — must not run:
 *
 *  - The field did not change at all and already contains `text`: a correct type
 *    into a field that held the same value is indistinguishable from an injection
 *    that landed nothing. (The clause below, with a selection that held `text`.)
 *  - The field now reads exactly `text` AND the prior content survived as edges:
 *    "abc" + a correct replacement by "abcdef" looks the same as "abc" plus a
 *    partial landing of "def" out of "abcdef". A hint reaches this shape too,
 *    whenever it happens to sit at an edge of the typed text — hint "0" under
 *    "100" — so a correct type into an empty field can land here. Declining is
 *    still the only sound answer: nothing in the two readings distinguishes it
 *    from the partial landing. (The whole-field reading of the clause below.)
 *  - The whole of `text` sits where replacing a SELECTION would have put it —
 *    `after` is `before` with one run cut out and `text` dropped in its place
 *    (`replacedSelection`). `input text` replaces the selection, so a field
 *    reading "aa bb" with "aa" double-tapped and "aaa" typed correctly ends at
 *    "aaa bb" (measured, Pixel-class API 35): the text is entirely present, and
 *    the field is `text.length` minus the selection longer rather than
 *    `text.length` longer. `not-landed` is wrong here in the
 *    expensive direction: the text is entirely present, so it would fail the step
 *    over a field holding exactly what was asked for. `landed` is unavailable
 *    too: a
 *    partial landing into content that happens to hold those characters produces
 *    the same reading.
 *  - Every character of `text` is present in order among characters the field
 *    added of its own (`isSubsequence(text, after)` while `text` is NOT there
 *    contiguously). That is what a field which REFORMATS what it is given does —
 *    "5551234567" typed into Contacts' Phone box reads back "(555) 123-4567" —
 *    and a dropped key-event burst cannot manufacture it, because dropping only
 *    ever removes characters. A `not-landed` here is a hard step failure across
 *    the three gates on a value that landed exactly as asked, which every phone,
 *    card, date and currency field would meet. Requiring `text` NOT to be there
 *    contiguously is what keeps a doubled injection ("abc" typed into an empty
 *    field reading back "abcabc") a failure: no single injection explains the
 *    text appearing twice, whereas separators between its characters are the
 *    field's own work.
 *
 * Known limitation, reported as `not-landed`: a selection replaced with a
 * *shorter* string shrinks the field, which reads as a failure — unless the
 * whole of `text` is still recoverable, where the two clauses above accept it as
 * ambiguous. What keeps the cost to a false alarm in the note rather than the
 * field's content is `plannedUndoDeletions`: it repairs only where one reading
 * of the two captures survives, so a residue that may be the user's surviving
 * text is refused instead of deleted.
 */
export function classifyTypedText(before: string, after: string, text: string): TypedTextVerdict {
  if (after.includes(text) && after.length === before.length + text.length) return "landed";
  if (after === text && !beforeSurvived(before, after)) return "landed";
  if (replacedSelection(before, after, text)) return "indeterminate";
  if (!after.includes(text) && isSubsequence(text, after)) return "indeterminate";
  return "not-landed";
}

/**
 * Whether `after` is `before` with one (possibly empty) run replaced by the whole
 * of `text` — the reading `input text` produces when the field had a selection.
 *
 * Checked against `before` rather than guessed from the lengths: an occurrence of
 * `text` in `after` only counts when what surrounds it is a prefix and a suffix
 * of `before`, which is what rules the reading out for a plain dropped burst
 * whose residue happens to contain the text. "abc" typed into a field reading
 * "abc" and landing "abcac" has an occurrence at 0, but "abc" does not end "ac",
 * so no selection explains it and the repair still runs.
 */
function replacedSelection(before: string, after: string, text: string): boolean {
  // A selection can only be removed, never added, so `after` can never be longer
  // than the field plus everything we typed.
  if (after.length > before.length + text.length) return false;
  for (let i = 0; i + text.length <= after.length; i++) {
    if (!after.startsWith(text, i)) continue;
    if (before.startsWith(after.slice(0, i)) && before.endsWith(after.slice(i + text.length))) {
      return true;
    }
  }
  return false;
}

/**
 * How many characters to delete to undo a failed injection, or null when no
 * deletion can be proven safe — in which case the field is left exactly as the
 * injection left it and the caller reports the failure instead of gambling with
 * the user's content.
 *
 * `input text` inserts at the cursor and advances it, and backspace deletes at
 * the cursor, so N backspaces remove exactly the N characters that landed —
 * wherever in the field the cursor sat, not only at the end. Verified on device
 * (Pixel 6 / API 34): with the cursor between the two characters of "ab",
 * injecting "XY" gives "aXYb", and two backspaces give "ab" back. The question
 * is therefore only how many of the characters present are ours.
 *
 * One model answers it. `input text` replaces the selection, so every reading of
 * the two captures has the shape
 *
 *     after === before[0, i) + landed + before[j, end)
 *
 * for a selection `[i, j)` — empty where the field had none — and a `landed` run
 * the key-event burst could have produced, which is a SUBSEQUENCE of `text`:
 * dropped-keystroke corruption only ever deletes events, never reorders or
 * invents them. `landed.length` is what this call put in the field, so it is the
 * deletion count that reading implies.
 *
 * Where every reading names the same count, that count is proven. Where two name
 * different counts, nothing is: both are live, and acting on either deletes
 * characters the other says are the user's. The overlap is not exotic. A
 * baseline that is a hint (`FocusedField.text`) can share an edge with the typed
 * text — hint `https://` under `https://example.com`, hint `0` under `100` — and
 * reading the growth as this call's whole contribution deletes `hint.length` too
 * few, the retype appends onto the residue, and the result is a doubled value
 * (`https://https://…`) shaped precisely to satisfy `classifyTypedText`'s first
 * branch: reported as `landed`, with no note, and greened by the flow `type`
 * gate. A selection does the same from the other side — "John Smith" with
 * "Smith" selected, `text: "John Smithe"`, the final character dropped, reads
 * "John John Smith", where deleting the growth takes the user's own word.
 *
 * Two properties fall out of the model rather than needing guards. `landed` is a
 * subsequence of `text`, which `assertTypeableAndroidText`
 * restricts to printable ASCII, so a deleted run can never hold a character the
 * FIELD put there — which matters because `KEYCODE_DEL` deletes a whole grapheme
 * cluster (`BaseKeyListener.getOffsetForBackspaceKey` handles surrogate pairs,
 * combining marks, keycap and ZWJ sequences) while the count is in UTF-16 code
 * units, so a field that rewrites ":)" into an emoji would have two presses
 * issued for one grapheme. And a field that only ever LOST characters — "abcdef"
 * read back as "abc" after typing "abcxyz" — offers readings that disagree, so
 * it is refused rather than emptied of the user's surviving text.
 */
export function plannedUndoDeletions(before: string, after: string, text: string): number | null {
  const added = after.length - before.length;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const typedChars = new Set(text);
  let steps = READING_SEARCH_STEPS;
  let proven: number | null = null;
  // `before[0, i)` has to survive into `after` unchanged, and so does
  // `before[j, end)`, which is what bounds the selection to the common edges.
  for (let i = 0; i <= prefix; i++) {
    // Every reading from this offset but the empty one starts its landed run at
    // `after[i]`, so a character the call never typed rules them all out at once
    // — without which a field of one repeated character costs the full search.
    const canStartRun = typedChars.has(after[i]!);
    for (let j = Math.max(i, before.length - suffix); j <= before.length; j++) {
      const landedLength = added + (j - i);
      if (landedLength < 0) continue;
      if (landedLength > text.length) break;
      // A selection is only replaced by the act of inserting over it, so a burst
      // that landed nothing left the selection alone too.
      if (landedLength === 0 && j !== i) continue;
      if (landedLength > 0 && !canStartRun) break;
      const { matched, scanned } = subsequenceScan(after.slice(i, j + added), text);
      // Charge what the scan reads, not the run it matches: a run that does not
      // match reads the whole of `text`, so counting characters read is what
      // makes the budget a bound on the work.
      steps -= scanned + 1;
      if (steps < 0) return null;
      if (!matched) continue;
      if (proven === null) proven = landedLength;
      else if (proven !== landedLength) return null;
    }
  }
  return proven;
}

/**
 * Work cap for the reading search, in characters of `text` read plus one per
 * reading, so a search over readings that read nothing still ends. Every offset
 * of the common prefix opens a reading per selection end, and every landed run is
 * matched against `text`, so the search grows with the field length times the
 * text length on a field whose characters keep those runs alive — synchronous CPU on the tool-server's only
 * thread, on a string a `describe` will happily hand back at 100 kB. Exhausting
 * the cap refuses the repair, which is the answer an ambiguous reading gets
 * anyway.
 */
const READING_SEARCH_STEPS = 2_000_000;

/**
 * Whether deleting one contiguous run of `gap` characters from `long` yields
 * `short`. Equivalent to the common prefix and common suffix of the two strings
 * together spanning `short`, which is the standard single-block-insertion test.
 */
function coversByEdges(short: string, long: string, gap: number): boolean {
  if (long.length !== short.length + gap) return false;
  let prefix = 0;
  while (prefix < short.length && short[prefix] === long[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < short.length - prefix &&
    short[short.length - 1 - suffix] === long[long.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix + suffix >= short.length;
}

/** Whether `candidate` can be obtained from `source` by deleting characters only. */
function isSubsequence(candidate: string, source: string): boolean {
  return subsequenceScan(candidate, source).matched;
}

/**
 * The subsequence test above, plus how much of `source` it had to read: the walk
 * stops on the character that completes `candidate`, so an empty candidate reads
 * nothing and a short run costs its position in `source` rather than the whole
 * string. That count is what `plannedUndoDeletions` charges its budget.
 */
function subsequenceScan(candidate: string, source: string): { matched: boolean; scanned: number } {
  let matched = 0;
  let scanned = 0;
  while (matched < candidate.length && scanned < source.length) {
    if (candidate[matched] === source[scanned]) matched++;
    scanned++;
  }
  return { matched: matched === candidate.length, scanned };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Re-inject `text` in small chunks — a different cadence, not a blind repeat. */
async function injectInChunks(serial: string, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += REPAIR_CHUNK_CHARS) {
    if (i > 0) await sleep(REPAIR_CHUNK_DELAY_MS);
    await injectAndroidText(serial, text.slice(i, i + REPAIR_CHUNK_CHARS));
  }
}

async function deleteTrailing(serial: string, count: number): Promise<void> {
  for (let remaining = count; remaining > 0; remaining -= DELETE_KEYCODES_PER_CALL) {
    await injectAndroidKeycodeRepeated(
      serial,
      KEYCODE_BACKSPACE,
      Math.min(remaining, DELETE_KEYCODES_PER_CALL)
    );
  }
}

/**
 * Advisory prose for every outcome that needs a caveat. No note contains the
 * field's text, so a `keyboard` call that typed a resolved `{{secret:…}}` cannot
 * echo the plaintext back. There is NO backstop behind this: `../index.ts`
 * deliberately does NOT substitute over `note` (doing so rewrites ordinary
 * words on healthy calls and swallows the counts these notes exist to report,
 * while matching whole values only — useless against a partial read-back), so
 * value-free-by-construction is the ONLY thing keeping a secret out of a note.
 * A note that starts quoting what the field holds is a plaintext leak. The
 * character counts DO reveal the resolved value's length — as `keys` already
 * does for every secret type, verified or not — so this bounds the leak at what
 * the result already exposed, it does not eliminate it.
 */
const UNVERIFIED_PREFIX = "The typed text was not verified against the screen";

const HELPER_UNAVAILABLE_NOTE =
  `${UNVERIFIED_PREFIX}: the android-devtools helper could not be reached for this call — it may ` +
  "be blocked on this device (it needs `adb install -t`) or it may have failed to start this " +
  "time — and the only other way to read the field back is a full `uiautomator dump` per call. " +
  "Android typing can silently drop characters on a field that re-renders per keystroke, so " +
  "confirm the field's contents with `describe` before relying on them.";

const NO_FOCUSED_FIELD_NOTE =
  `${UNVERIFIED_PREFIX}: no editable field held input focus, so there was nothing to read back — ` +
  "the characters may have gone nowhere. Tap the field first (or check `describe` for a focused " +
  "text field), then type.";

// Something HAS focus; it is just not a view this check can read back. Reported
// apart from the note above, whose "tap the field first" would send the agent to
// re-tap a field that already had focus — the same distinction the truncated
// capture draws. `EDITABLE_CLASS_RE` cannot enumerate every focus-taking editor:
// a widget with its own `onCreateInputConnection` (a PIN or OTP box, a
// canvas-drawn editor) or a `WebView` that does not expose its inputs as nodes
// reaches here.
function unrecognisedFocusNote(className: string): string {
  return (
    `${UNVERIFIED_PREFIX}: the view holding input focus (\`${className}\`) is not one this check ` +
    "can read back — its class is neither an `EditText` nor an `AutoComplete` subclass, which a " +
    "custom editor or a `WebView` that does not expose its inputs can be. Focus was NOT the " +
    "problem, so do not re-tap the field; the text was typed and may well have landed. Read the " +
    "field with `describe` to confirm."
  );
}

// Same situation, but the capture hit its node cap, so "nothing had focus" is not
// a conclusion the read supports — a dense screen can truncate before the walk
// reaches the field. Saying "tap the field first" here would send the agent to
// re-tap a field that already had focus.
const TRUNCATED_READ_NOTE =
  `${UNVERIFIED_PREFIX}: the screen has more elements than one capture returns, so the read was ` +
  "truncated before any focused editable field was found. This says nothing about whether the " +
  "text landed — read the field with `describe` to confirm.";

const PASSWORD_FIELD_NOTE =
  `${UNVERIFIED_PREFIX}: the focused field masks its input, so it reads back as bullets rather ` +
  "than characters and there is nothing to compare — and reading a credential back to compare it " +
  "is exactly what typing a `{{secret:…}}` placeholder exists to avoid, so it is deliberately not " +
  "read. Android typing can silently drop characters, so a credential that fails to authenticate " +
  "may simply have been typed incompletely: clear the field and retype rather than assuming the " +
  "credential is wrong.";

const READ_FAILED_REASON =
  "reading the focused field back failed. The text was typed, but Android " +
  "typing can silently drop characters — confirm the field's contents with `describe`.";

// Distinct from a read failure: both reads succeeded and the field in focus
// afterwards is not the one the text was typed into. Telling the agent to hunt
// dropped characters would bury the actionable fact. Every cause is named because
// the read cannot tell them apart — see `isSameField`.
const FOCUS_MOVED_REASON =
  "the focused field is no longer the one the text was typed into, so that " +
  "field could not be checked — either input focus moved to another field while the text was " +
  "being typed, in which case the text may have been split across both, or the field could not be " +
  "matched again after moving on screen (a chat composer growing to a second line does this), " +
  "because it carries no id or one its neighbours share, as an OTP form's boxes do. Read the screen with `describe` before continuing.";

// Separate from the above: nothing editable holds focus at all now. There is no
// second field for the text to have been split across, so claiming focus "moved"
// would send the agent looking for one.
const FOCUS_LOST_REASON =
  "no editable field held input focus once the text had been typed, so the " +
  "field it started in could not be checked. Read the screen with `describe` before continuing.";

// The read-back equivalent of TRUNCATED_READ_NOTE. A capture that stopped before
// reaching the field proves nothing about focus, so it must not be reported as a
// focus change — the same reason the baseline read distinguishes the two.
const TRUNCATED_AFTER_REASON =
  "the screen has more elements than one capture returns, so the read-back " +
  "was truncated before the field could be found again. Read the field with `describe` to see " +
  "what it holds.";

// The field masks its input NOW though it did not when the text was typed — a
// `TextInputLayout` reveal toggle flipped back, or a PIN field that masks after
// its first character. It reads back as bullets, so the comparison could not
// work; and the baseline read declines a masked field for a second reason that
// applies just as much here, that a credential must not be read back to be
// compared at all (see `FocusedField.password`). Checked on BOTH reads, or the
// contract holds on only one of them.
const MASKED_AFTER_REASON =
  "the focused field masks its input now, though it did not when the text " +
  "was typed — a password reveal toggle, or a field that masks once it holds something. It reads " +
  "back as bullets rather than characters, so there is nothing to compare, and reading a " +
  "credential back to compare it is what typing a `{{secret:…}}` placeholder exists to avoid.";

/**
 * Close a blocked read-back with what the call did to the field.
 *
 * The repair backspaces and retypes BEFORE the confirming read, so every one of
 * these outcomes is reachable with the field already modified. Saying "nothing
 * was retyped" there would be false about a destructive action and would invite
 * the caller to type the value a third time.
 */
function blockedNote(reason: string, deleted: number | null): string {
  if (deleted === null) return `${UNVERIFIED_PREFIX}: ${reason} Nothing was retyped.`;
  // `adb input` goes to whatever holds focus at the moment it runs, so a focus
  // change that happened before the repair sent the backspaces and the retype
  // into the OTHER field. That is the worst state this module can leave behind
  // and the only note that can name it.
  const misdirected =
    reason === FOCUS_MOVED_REASON
      ? " If focus moved before the retry rather than during the read, those key events reached " +
        "the field that holds focus now, not the one the text was typed into."
      : "";
  return `${UNCONFIRMED_REPAIR_PREFIX}: ${reason} ${retypedClause(deleted)}${misdirected}`;
}

/**
 * What the repair did to the field, for the notes that follow one. A planned
 * count of zero is the module's headline shape — a field that took none of the
 * burst has nothing of ours to remove — so the deletions cannot be asserted.
 */
function retypedClause(deleted: number): string {
  if (deleted === 0) {
    return (
      "Nothing had to be deleted first, but the text had already been retyped in smaller chunks, " +
      "so the app has seen both rounds of key events."
    );
  }
  return (
    "The characters this call could attribute to itself had already been deleted and retyped in " +
    "smaller chunks, so the field has been modified beyond the original typing."
  );
}

// Only the confirming read is blocked on that path, so the last thing actually
// measured is the failure that sent the call to the repair. `UNVERIFIED_PREFIX`
// would report it as an unchecked call, which is the value every gate passes.
const UNCONFIRMED_REPAIR_PREFIX =
  "The typed text did NOT land in the focused field, and whether retyping it fixed that could " +
  "not be checked";

// The observation is consistent with success AND with failure (see
// `classifyTypedText`, which enumerates the four shapes that reach here). Acting
// on it is what would double the text or overwrite a field that is already
// right, so the only safe move is to say so.
const INDETERMINATE_BASE =
  `${UNVERIFIED_PREFIX}: what the field holds is equally consistent with the text having landed ` +
  "and with it having been dropped — it did not change and already contained the text, or it now " +
  "reads exactly as the text while its previous value could have been part of the result, or it " +
  "holds the whole of the text with the rest of its content around it (what replacing a selected " +
  "word looks like), or it holds every character typed, in order, among characters of its own " +
  "(what a field that reformats a phone or card number does).";

const INDETERMINATE_NOTE =
  `${INDETERMINATE_BASE} Nothing was retyped, because doing so on this evidence risks entering ` +
  "the text twice or overwriting a value that is already correct. Read the field with `describe` " +
  "to confirm.";

// The same verdict reached AFTER the repair ran. It must not be collapsed into
// `verified: false` the way the pre-repair site is not: a repair that restored
// the field lands here — an empty phone box that took "555" of "5551234567" and
// reformats the retyped number to "(555) 123-4567" — and reporting that as a
// failure, over prose telling the caller to send a value the field accepts,
// states the opposite of what happened. The field WAS modified by the repair,
// which is why this does not reuse the sentence above.
function indeterminateAfterRepairNote(deleted: number): string {
  return `${INDETERMINATE_BASE} ${retypedClause(deleted)} Read the field with \`describe\` to confirm.`;
}

/**
 * Three readings produce this and the read-back cannot tell them apart, so the
 * note carries all of them rather than asserting the likeliest: the key-event
 * burst lost characters on a field that re-renders per keystroke, the field
 * itself rejected or reformatted what arrived (a digits-only field, an input
 * mask, a maxLength — the dialer's number field silently drops every letter typed
 * into it), or PART of the text replaced a selection, which takes the selected
 * run out of the field on top of whatever the burst dropped. A whole replacement
 * never arrives here: `replacedSelection` calls that `indeterminate`. Retyping in
 * chunks fixes the first and neither of the others, which is why the advice
 * covers all three.
 */
function mismatchNote(typed: number, present: number, repaired: boolean): string {
  return (
    `The typed text did NOT land in the focused field: ${typed} ` +
    `character${typed === 1 ? "" : "s"} ${typed === 1 ? "was" : "were"} typed and the field now ` +
    `holds ${present} in total. That total counts whatever the field already showed — an empty ` +
    "field reads back as its hint — so it is not a count of how many characters were lost" +
    (repaired
      ? ", and retyping it in smaller chunks did not fix it either"
      : ", and the field could not be safely restored to retry, so nothing was retyped") +
    ". Either Android's key-event burst lost characters on a field that re-renders " +
    "per keystroke, or the field rejects or reformats what is typed into it (a " +
    "digits-only field, an input mask, a maxLength) — or part of it replaced a " +
    "selection, which removes the selected run as well. Read the field with " +
    "`describe` to see what it holds, then either type in shorter pieces or send a " +
    "value the field accepts."
  );
}

// The retry itself failed to reach the device. It runs backspaces before
// retyping, so the field can be left holding LESS than when the call started —
// the one path where that is possible, and it must be reported rather than
// swallowed into a generic transport error.
function repairFailedNote(deleted: number): string {
  if (deleted === 0) {
    return (
      "The typed text did not land, and the retry could not be completed: nothing had to be " +
      "deleted first, and the retype did not finish. The field may hold anything from what it " +
      "held before this call to that plus a truncated copy of the text. Read it with `describe` " +
      "and retype from a known state."
    );
  }
  return (
    `The typed text did not land, and the retry could not be completed: ${deleted} ` +
    `character${deleted === 1 ? "" : "s"} ${deleted === 1 ? "was" : "were"} removed, or partly ` +
    "removed, and the retype did not finish. The field may hold anything from less than it did " +
    "before this call to a truncated copy of the text. Read it with `describe` and retype from a " +
    "known state."
  );
}

// A repair that WORKED still changed the field beyond what the caller asked for:
// it backspaced the characters it could attribute to this call and retyped them
// in chunks. Those presses are app-visible events — a search box re-queries on
// each one, a recipients field drops the previous chip on a backspace at
// position 0, an OTP box steps focus back a slot — and every OTHER post-repair
// outcome says the field was modified. This is the one that actually did it.
function repairedNote(deleted: number): string {
  if (deleted === 0) {
    return (
      "The typed text is in the field, but not from the first attempt: Android's key-event burst " +
      "did not deliver it, so it was retyped in smaller chunks. Nothing had to be deleted first, " +
      "but the app saw both rounds of key events."
    );
  }
  return (
    "The typed text is in the field, but not from the first attempt: Android's key-event burst " +
    `did not deliver it, so ${deleted} character${deleted === 1 ? "" : "s"} ` +
    `${deleted === 1 ? "was" : "were"} deleted and the text was retyped in smaller chunks. Those ` +
    "backspaces reached the app as key events, so the field has been modified beyond the original " +
    "typing and anything watching it saw the intermediate states."
  );
}

async function resolveDevtools(
  registry: Registry,
  device: DeviceInfo
): Promise<AndroidDevtoolsApi | null> {
  try {
    const ref = androidDevtoolsRef(device);
    return await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    // Every failure here is recoverable by degrading to an unverified type. The
    // permanent one is a locked-down device refusing `adb install -t`, but this
    // also catches a spawn that failed or hit the blueprint's ready timeout, so
    // the note it produces must not call the helper unavailable for good.
    // Surfaced at debug level, the way the describe adapter does for the same
    // fallback.
    console.debug(
      `[keyboard.android] devtools unavailable, typing without read-back verification: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * `clearCache: true` is mandatory. The helper holds one long-lived
 * UiAutomation connection whose `AccessibilityNodeInfo` cache serves stale text
 * — the exact reason `flows/flow-android-tree.ts` passes it as well. Without it
 * the "after" read can return the pre-typing value and the verification would be
 * theatre.
 *
 * `maxNodes` matches the flow tree's raised cap for the same reason it was
 * raised there: the helper's 5000 default truncates a dense screen mid-walk, and
 * a capture that stops before the focused field is reached is indistinguishable
 * from a screen with no focused field. `truncated` is returned so that case can
 * be reported as the unknown it is rather than as a diagnosis.
 */
const READ_MAX_NODES = 12_000;

async function readFocusedField(
  devtools: AndroidDevtoolsApi
): Promise<{ field: FocusedField | null; focusedClass: string | null; truncated: boolean }> {
  const { xml, truncated } = await devtools.getHierarchy({
    clearCache: true,
    maxNodes: READ_MAX_NODES,
  });
  const found = findFocused(xml);
  // A capture cut short cannot show an id to be unique: the helper writes nodes
  // in document order, so the view that shares it may be one it never reached.
  if (found.field && truncated) found.field.idShared = true;
  return { ...found, truncated };
}

/**
 * Type `text` into the focused field and prove it landed.
 *
 * Injects exactly once on every path — the text is typed whether or not it can
 * be verified — plus at most one chunked re-injection when the first attempt is
 * caught having dropped characters. Two attempts total: each one costs a
 * hierarchy read, and a field that drops events under both a single burst and a
 * slow chunked cadence is not failing for cadence reasons (an input mask,
 * autocorrect, a maxLength, a field rejecting characters), so a third identical
 * retry would only add latency to the same wrong answer.
 *
 * Never throws for a verification problem, including one raised by the retry
 * itself: by the time anything here can go wrong the original keystrokes are
 * already on the device, so a thrown error would tell the agent the typing failed
 * when it may well have succeeded. Every verification outcome comes back as
 * `verified: true`, `verified: false`, or an absent `verified` with a note
 * explaining why the check could not conclude. Two things do throw: errors from
 * the injection the call is actually FOR — a failed `input text` is a real
 * failure, not a verification problem — and a cancelled `signal`, which is
 * consulted where nothing has been typed yet, before the destructive repair
 * starts, and before every verdict — a run the caller gave up on is owed a skip,
 * not a finding about the app.
 */
export async function typeAndroidTextVerified(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  signal?: AbortSignal
): Promise<KeyboardVerification> {
  const serial = device.id;
  const devtools = await resolveDevtools(registry, device);
  // Resolving installs the helper APK on a cold device and spawns it, which can
  // take minutes, so the caller can be gone before anything would be typed.
  // Nothing is waiting for those keystrokes, and they would land in whatever
  // holds focus by now, so this must not type at all. Throwing (rather than
  // reporting a verdict) is what makes a cancelled flow read the step as a skip
  // instead of an app failure.
  signal?.throwIfAborted();
  if (!devtools) {
    await injectAndroidText(serial, text);
    return { note: HELPER_UNAVAILABLE_NOTE };
  }

  // The helper closes a socket left idle for 60 s (SOCKET_READ_TIMEOUT_MS in
  // SnapshotInstrumentation.java), and every stretch of adb work below is silent
  // on it: `injectAndroidText` alone is one `input text` per `%`-terminated
  // segment, and the repair is a call per 8 characters. The close tears down the
  // whole service, so the reads below would fail AND every other tool sharing
  // the helper would pay a cold start.
  const keepalive = setInterval(() => {
    void devtools.ping().catch(() => {});
  }, DEVTOOLS_KEEPALIVE_MS);
  try {
    return await verifyAgainstDevtools(devtools, serial, text, signal);
  } finally {
    clearInterval(keepalive);
  }
}

/** The read-inject-compare-repair body, with the helper connection held open. */
async function verifyAgainstDevtools(
  devtools: AndroidDevtoolsApi,
  serial: string,
  text: string,
  signal?: AbortSignal
): Promise<KeyboardVerification> {
  const baseline = await readFocusedField(devtools).catch(() => null);
  // A whole hierarchy dump stands between the check above and the first
  // keystroke, so the caller can give up inside it. Past this point the text is
  // typed on every path, including the one that gives up on reading the field.
  signal?.throwIfAborted();
  if (!baseline) {
    await injectAndroidText(serial, text);
    return { note: blockedNote(READ_FAILED_REASON, null) };
  }
  const { field: before, focusedClass: beforeFocusedClass, truncated: beforeTruncated } = baseline;
  if (!before) {
    await injectAndroidText(serial, text);
    if (beforeTruncated) return { note: TRUNCATED_READ_NOTE };
    // Something has focus, just not something readable: saying "tap the field
    // first" would be advice for a screen this is not.
    return {
      note:
        beforeFocusedClass === null
          ? NO_FOCUSED_FIELD_NOTE
          : unrecognisedFocusNote(beforeFocusedClass),
    };
  }
  if (before.password) {
    await injectAndroidText(serial, text);
    return { note: PASSWORD_FIELD_NOTE };
  }

  await injectAndroidText(serial, text);

  const after = await readAfter(devtools, before, null);
  // Past here the call reports on the field, and a caller that gave up is owed a
  // skip instead of a report: the three step gates key on `verified: false`, while
  // both flow gates read a rejection as the uniform aborted skip (`run-sequence`,
  // which has no skip, records it as that step's error). So the signal is re-read
  // before each outcome — the burst, the repair and the reads between them are
  // all long enough to be given up on.
  signal?.throwIfAborted();
  if (after.blocked) return after.blocked;
  const verdict = classifyTypedText(before.text, after.field.text, text);
  if (verdict === "landed") return { verified: true };
  if (verdict === "indeterminate") return { note: INDETERMINATE_NOTE };

  const deletions = plannedUndoDeletions(before.text, after.field.text, text);
  if (deletions === null) {
    return { verified: false, note: mismatchNote(text.length, after.field.text.length, false) };
  }
  // The repair is the one destructive sequence on this path — it deletes before
  // it retypes — so it must not START once the caller has given up: nothing is
  // waiting for the retyped field, and the MCP adapter replays a call it
  // abandoned. Not re-read inside the loops below: once the delete has run,
  // finishing the retype leaves the field in a better state than abandoning it
  // half-restored.
  signal?.throwIfAborted();

  let repairFailed = false;
  try {
    await deleteTrailing(serial, deletions);
    await injectInChunks(serial, text);
  } catch {
    repairFailed = true;
  }
  // The repair spends tens of seconds on the device without consulting the
  // signal, which makes it the widest window in the call for the caller to give
  // up in.
  signal?.throwIfAborted();
  if (repairFailed) {
    // The undo runs before the retype, so a failure between them can leave the
    // field emptier than the call found it. Report that state instead of letting
    // an adb error imply nothing happened.
    return { verified: false, note: repairFailedNote(deletions) };
  }

  const repaired = await readAfter(devtools, before, deletions);
  signal?.throwIfAborted();
  if (repaired.blocked) return repaired.blocked;
  const repairedVerdict = classifyTypedText(before.text, repaired.field.text, text);
  if (repairedVerdict === "landed") return { verified: true, note: repairedNote(deletions) };
  // Not collapsed into `verified: false`: see indeterminateAfterRepairNote.
  if (repairedVerdict === "indeterminate") {
    return { note: indeterminateAfterRepairNote(deletions) };
  }
  return { verified: false, note: mismatchNote(text.length, repaired.field.text.length, true) };
}

/**
 * Re-read the field the call started in, or the reason it cannot be compared:
 * the read failed, it was truncated before reaching the field, nothing editable
 * has focus any more, focus is on a DIFFERENT field than the baseline (which
 * makes both the comparison and a deletion-based repair meaningless — see
 * `isSameField`), or the field masks its input now.
 *
 * `deleted` is what the repair removed before retyping, or null when this is the
 * read that precedes any repair.
 */
async function readAfter(
  devtools: AndroidDevtoolsApi,
  before: FocusedField,
  deleted: number | null
): Promise<
  | { blocked?: undefined; field: FocusedField }
  | { blocked: KeyboardVerification; field?: undefined }
> {
  // After the repair the verdict is not open: the text was measured not to have
  // landed, and the field was then backspaced and retyped. A blocked read leaves
  // that the last thing known about it, so the verdict travels with the note —
  // an absent one is the pass value at all three step gates, which would submit
  // exactly the field with the most evidence against it and the most changes
  // made to it.
  const blocked = (reason: string): { blocked: KeyboardVerification } => ({
    blocked: {
      ...(deleted === null ? {} : { verified: false }),
      note: blockedNote(reason, deleted),
    },
  });

  let field: FocusedField | null;
  let truncated: boolean;
  try {
    ({ field, truncated } = await readFocusedField(devtools));
  } catch {
    return blocked(READ_FAILED_REASON);
  }
  if (!field) {
    // A truncated capture never reached the field, so "nothing has focus" is not
    // a conclusion it supports — the same distinction the baseline read draws.
    return blocked(truncated ? TRUNCATED_AFTER_REASON : FOCUS_LOST_REASON);
  }
  if (!isSameField(before, field)) {
    return blocked(FOCUS_MOVED_REASON);
  }
  // The baseline read declines a masked field; so must this one, or the contract
  // holds on only one of the two and a field that starts masking mid-typing gets
  // its bullets compared as content and its credential backspaced and re-injected.
  if (field.password) {
    return blocked(MASKED_AFTER_REASON);
  }
  return { field };
}
