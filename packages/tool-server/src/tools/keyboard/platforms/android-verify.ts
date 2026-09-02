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
 * and `adb` still exits 0 having "typed" the whole string. On a Pixel 6 / API 34
 * emulator, one `input text` of a 76-character sentence into the Settings search
 * box landed 45 characters and reported success; the same sentence in 8-character
 * chunks landed all 76. So the only way to know what a call did is to read the
 * focused field before and after and compare.
 *
 * Only this backend does it. iOS / Chromium / Vega synthesise no KeyEvent burst
 * and are not exposed; Android TV is, and `platforms/tv.ts` says why it is not
 * verified there.
 *
 * Cost, and why it is unconditional. Verifying adds two `getHierarchy` calls,
 * each waiting for the screen to go quiet: 76 characters into that search box
 * measured 1.6-1.8 s unverified and 1.9-3.4 s verified. A repair adds a third
 * read plus its own adb calls, which dominate — 8-14 s for a 200-character
 * repair, 24-41 s for a 600-character one, and more for a string full of `%`,
 * which `injectAndroidText` splits into a call per character. Hence
 * `longRunning`: past ~30 s the MCP adapter abandons the request and replays it,
 * and this tool is not idempotent (see `../index.ts`). The first typed string on
 * a device also pays for the helper — an `adb install -t` of the APK, outside the
 * blueprint's 30 s READY timeout, which bounds only the `am instrument` spawn:
 * 6.1 s with the install, 1.8 s without. It is the helper `describe` resolves, so
 * a described device has already paid it.
 *
 * Not gated on length or a flag, because the corruption is a property of the
 * *field*, not of the text: QA saw one sentence land perfectly in one field and
 * corrupt in another on the same screen at the same moment, and a field that
 * re-renders per keystroke can lose a single character. What IS gated is the
 * transport: without the android-devtools helper the only read-back is a
 * `uiautomator dump` per read, with no persistent connection to amortise, so
 * verification is skipped and said to be skipped rather than charging a
 * locked-down device (exactly the device where `adb install -t` is blocked) two
 * dumps per typed string.
 *
 * No read passes `waitForIdleMs`, so each takes the blueprint's 500 ms settle.
 * Zeroing it on the "before" read would save that, but that read follows the
 * agent's own tap: read before the framework publishes `focused="true"` and a
 * healthy call reports "no editable field had focus".
 */

/**
 * Classes whose focused instance receives the KeyEvents `input text` generates.
 * `EditText` covers React Native `TextInput`, Compose `TextField` (its semantics
 * delegate reports `android.widget.EditText`) and WebView inputs; `AutoComplete`
 * catches the `EditText` subclasses whose simple name lacks "EditText"
 * (`AutoCompleteTextView`, `SearchView$SearchAutoComplete`).
 *
 * Deliberately broader than the `/EditText/` probe in
 * `blueprints/android-tv-control.ts`: there a missed subclass costs a label, here
 * it silently disables the check.
 */
const EDITABLE_CLASS_RE = /EditText|AutoComplete/;

const KEYCODE_BACKSPACE = ANDROID_NAMED_KEYCODES.backspace;

/**
 * Re-injection cadence for the repair; the chunk size is the one measured above.
 * The per-call `app_process` spawn (~200-400 ms) already spaces the calls — the
 * explicit delay makes the cadence independent of how fast adb happens to be.
 */
const REPAIR_CHUNK_CHARS = 8;
const REPAIR_CHUNK_DELAY_MS = 100;

/**
 * `input keyevent` takes several keycodes per call and injects them from one
 * `app_process` boot; capped so the device-side command line stays short.
 *
 * Un-paced, unlike the retype: one call of 64 `KEYCODE_DEL` removed exactly 64
 * characters in 5 runs of 5 on the Settings search box (Pixel 6 / API 34), on a
 * field filled both by a paced retype and by a single `input text`.
 */
const DELETE_KEYCODES_PER_CALL = 64;

// Half the helper's own 60 s socket read timeout, so one missed tick still
// leaves the connection open.
const DEVTOOLS_KEEPALIVE_MS = 30_000;

interface FocusedField {
  /**
   * The field's `text` as the accessibility tree reports it — for an empty
   * `EditText` with a hint, that is the HINT, not "": `TextView`'s
   * `getTextForAccessibility()` falls back to it (API 34: the empty Settings
   * search box reports `text="Search settings"`). So this is not the field's
   * content, and `classifyTypedText` must not treat it as such.
   */
  text: string;
  /** The field's `resource-id`, or "" when it has none. See `isSameField`. */
  resourceId: string;
  /**
   * Whether the `resource-id` fails to identify this field: another editable view
   * in the same capture carries it, making it a layout id, or the capture was
   * truncated and cannot show it to be unique. See `isSameField`.
   */
  idShared: boolean;
  /** The field's `class`. See `isSameField`. */
  className: string;
  /** The field's bounds, or null when they do not parse. See `isSameField`. */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /**
   * Whether the focused field masks its input. Two reasons to skip the read-back.
   * It could not work: an `EditText` holding `SecretPass1` reads back
   * `text="•••••••••••"` through the helper on API 34, so every credential would
   * be reported `verified: false`. And it must not be relied on to work: masking
   * is the platform's default, not a guarantee, which is why
   * `uiautomator-parser.ts` and `flows/flow-android-tree.ts` replace such a
   * field's text with `[password]`. Comparing a credential we read back would put
   * the plaintext one refactor away from the result, against this tool's
   * `{{secret:…}}` contract.
   */
  password: boolean;
}

/**
 * What holds input focus in a uiautomator-schema hierarchy, walked in document
 * order, first match wins.
 *
 * `field` is the focused view this check can read back; `focusedClass` is the
 * class of the FIRST focused view of any kind, which separates "nothing has
 * focus" from "something has focus that `EDITABLE_CLASS_RE` does not cover" — the
 * first is answered by "tap the field", the second is not.
 *
 * The helper writes one subtree per window under `<hierarchy>`, so its top-level
 * children ARE the windows, and that is what the two flags read:
 *
 *  - `contendedFocus`: focused editable views in more than one window. Android
 *    focuses one view per window and `adb input text` reaches whichever window
 *    really takes input, which no dump says, so the field this walk picked may be
 *    a stale one behind a dialog. Two inside ONE window is the recycled row's
 *    twin, which `isSameField` handles.
 *  - `empty`: no window at all. The helper emits a bare `<hierarchy/>` when its
 *    windows pass writes nothing — `getWindows()` empty or throwing, or every root
 *    failing the refresh it does below API 34 — and the active window has no root
 *    either, which a screen mid-transition or a display gone off gives. It
 *    supports no finding about focus.
 *
 * The helper's own `windowCount` is not read for either: it counts every
 * interactive window, and the IME and the system bars make it 3 on the plain
 * Settings search box (measured, API 34).
 */
function findFocused(xml: string): {
  field: FocusedField | null;
  focusedClass: string | null;
  contendedFocus: boolean;
  empty: boolean;
} {
  const windows = parseUiAutomatorXml(xml)?.children ?? [];
  if (windows.length === 0)
    return { field: null, focusedClass: null, contendedFocus: false, empty: true };
  let focusedClass: string | null = null;
  let field: FocusedField | null = null;
  let fieldWindow = -1;
  let contendedFocus = false;
  // Counted over the whole capture, not stopped at the field: an id several
  // editable views share is a layout id, which `isSameField` must not trust.
  const idCounts = new Map<string, number>();
  for (let window = 0; window < windows.length; window++) {
    const stack = [windows[window]!];
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
      if (!attrIsTrue(attrs, "focused")) continue;
      if (focusedClass === null) focusedClass = className;
      if (!editable) continue;
      if (field === null) {
        const rect = parseUiAutomatorBounds(attrs.bounds ?? "");
        field = {
          text: attrs.text ?? "",
          resourceId,
          className,
          bounds: rect,
          password: attrIsTrue(attrs, "password"),
          idShared: false,
        };
        fieldWindow = window;
      } else if (window !== fieldWindow) {
        contendedFocus = true;
      }
    }
  }
  if (field !== null) field.idShared = (idCounts.get(field.resourceId) ?? 0) > 1;
  return { field, focusedClass, contendedFocus, empty: false };
}

/** The focused editable view, or null when none of the focused views is one. */
export function findFocusedTextField(xml: string): FocusedField | null {
  return findFocused(xml).field;
}

/**
 * Whether the after-read is looking at the field the text was typed into.
 *
 * The point is to catch focus moving to a DIFFERENT field between the two reads —
 * an auto-advancing form (an OTP code split across boxes, a field that jumps on
 * maxLength) does exactly that, and comparing one field's baseline against
 * another's text would have the repair retype into a field the caller never
 * targeted.
 *
 * A different widget class settles it first. Past that the two discriminators are
 * weighed rather than concatenated. A `resource-id` no other editable view in the
 * capture carries settles it alone: it is the Android view id, carrying the React
 * Native `testID` (see `flows/flow-android-tree.ts`), and it survives the field
 * moving. A shared one identifies nothing — `getViewIdResourceName` reports the id
 * of the layout, so six `<include>`d or recycled OTP boxes all read
 * `…:id/otp_digit` — and matching on it would put the repair's backspaces and
 * retype into box 1 while the caller typed into box 2, reported as verified.
 * Position is the fallback for those and for a field with no id at all, which
 * every untagged `TextInput` and Compose `TextField` is.
 *
 * Position is an OVERLAP test, not an equality one, because typing MOVES fields —
 * the same predicate and the same reason as `framesOverlap` in
 * `flows/flow-actions.ts`. Typing into the Settings search box moved its right
 * edge from 1080 to 933 (measured, API 34) and a bottom-anchored composer grows
 * upward as it wraps; both still cover their old rectangle, and two boxes of a
 * form never cover each other's. A field that moves clear of where it was — a list
 * scrolled by more than a row — reads as a focus change, which declines the repair.
 *
 * Known limitation: a duplicate id is only visible where the capture holds both
 * views, so two screens or two pager pages reusing one layout show one view each
 * and the position test never runs.
 */
function isSameField(a: FocusedField, b: FocusedField): boolean {
  if (a.className !== b.className) return false;
  if (a.resourceId !== b.resourceId) return false;
  if (a.resourceId !== "" && !a.idShared && !b.idShared) return true;
  return boundsOverlap(a.bounds, b.bounds);
}

/**
 * Whether two parsed bounds share any pixel, with an identical rectangle always
 * matching itself: a keystroke-capture `TextInput` dumps `[540,1200][540,1200]`,
 * and an area test excludes a zero-area rect from its own area, refusing to match
 * such a field even against its own unchanged read. (`framesOverlap` in
 * `flows/flow-actions.ts` shares the blind spot.) Two DIFFERENT untagged fields
 * drawn at one point stay indistinguishable, which is the price. Unparseable
 * bounds identify nothing.
 */
function boundsOverlap(a: FocusedField["bounds"], b: FocusedField["bounds"]): boolean {
  if (!a || !b) return false;
  if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * What the before/after pair says about the injection. `indeterminate` is not
 * hedging: typing "argent" into a `selectAllOnFocus` field that already reads
 * "argent" changes nothing, and so does having every key event of it dropped —
 * see `classifyTypedText` for the readings that reach it.
 */
type TypedTextVerdict = "landed" | "not-landed" | "indeterminate";

/** Whether `before` survives whole in `after`, split by at most one insertion. */
function beforeSurvived(before: string, after: string): boolean {
  return (
    after.length >= before.length && coversByEdges(before, after, after.length - before.length)
  );
}

/**
 * Classify the injection from the field's text before and after it.
 *
 * Accepted:
 *
 *  - *inserted*: `text` appears contiguously and the field grew by exactly
 *    `text.length`, wherever the cursor sat and whatever the field held. A dropped
 *    character breaks the first half, a doubled injection the second.
 *  - *replaced*: the field now holds precisely `text` and `before` did NOT survive
 *    into it whole — which an unchanged field cannot satisfy, since `before`
 *    always survives into itself. An edge of the prior content shared with `text`
 *    is not ruled out, so a partial landing the field's own residue completes into
 *    exactly `text` reads as landed: the field holds what was asked for, which is
 *    all the verdict claims. That is the empty-field case (the baseline was the
 *    hint — see `FocusedField.text`) and equally a selection `input text`
 *    replaced.
 *
 * Ambiguous, reported as `indeterminate` and never repaired: BOTH a correct
 * injection and a partial landing produce each of these readings, and the repair
 * would delete and retype on top of a field that may already be right.
 *
 *  - The field did not change and already contains `text`.
 *  - It reads exactly `text` AND `before` survived as edges: "abc" correctly
 *    replaced by "abcdef" looks like "abc" plus a partial landing of "def". A hint
 *    at an edge of the typed text reaches this too — hint "0" under "100" — so a
 *    correct type into an empty field can land here.
 *  - The whole of `text` sits where replacing a SELECTION would have put it
 *    (`replacedSelection`): "aa bb" with "aa" double-tapped and "aaa" typed
 *    correctly ends at "aaa bb" (measured, Pixel-class API 35), so the field is
 *    `text.length` minus the selection longer. `not-landed` would fail the step
 *    over a field holding exactly what was asked for; `landed` is unavailable
 *    because a partial landing into content holding those characters reads the
 *    same.
 *  - Every character of `text` is present in order among characters the field
 *    added of its own, with `text` NOT there contiguously — what a field that
 *    REFORMATS does ("5551234567" into Contacts' Phone box reads back
 *    "(555) 123-4567"), which `not-landed` would fail across all three gates. Not
 *    accepted either: a dropped burst reads this way on a field that already held
 *    characters of its own, and on an empty one through its hint — a burst that
 *    landed NOTHING into a box hinting "(555) 123-4567" reads back exactly what a
 *    correct "5551234567" would. The contiguity requirement is what keeps a
 *    doubled injection ("abc" into an empty field reading back "abcabc") a failure.
 *
 * Known limitation, reported as `not-landed`: a selection replaced with a
 * *shorter* string shrinks the field, unless the whole of `text` is still
 * recoverable by the two clauses above. `plannedUndoDeletions` keeps the cost to a
 * false alarm rather than lost content: it repairs only where one reading of the
 * two captures survives.
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
 * `text` counts only when what surrounds it is a prefix and a suffix of `before`,
 * which rules the reading out for a dropped burst whose residue happens to contain
 * the text. "abc" typed into a field reading "abc" and landing "abcac" has an
 * occurrence at 0, but "abc" does not end "ac", so no selection explains it and
 * the repair still runs.
 */
function replacedSelection(before: string, after: string, text: string): boolean {
  // A selection is only ever removed, so `after` cannot exceed `before` + `text`.
  if (after.length > before.length + text.length) return false;
  // These bounds are exactly the common edges — `before` starts with `after[0, i)`
  // iff `i` is inside the common prefix, and ends with the tail past `text` iff
  // that tail is inside the common suffix. Re-checking them per offset instead
  // costs the field's length for every occurrence of `text`: 14.5 s of synchronous
  // CPU on a 200 kB field of one repeated word (measured), on the thread every
  // other tool shares and with `longRunning` having removed the adapter's own
  // bound.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length &&
    suffix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const first = Math.max(0, after.length - text.length - suffix);
  const last = Math.min(prefix, after.length - text.length);
  // Capped like `plannedUndoDeletions`, and counting characters compared rather
  // than offsets tried so only a genuinely quadratic reading pays: a field that is
  // one character repeated keeps every offset matching almost to the end of `text`,
  // measured at ~1.1 s for 200 kB against a 2,000-character string. Exhausting the
  // cap answers "cannot rule this out", which reads as indeterminate and repairs
  // nothing.
  let steps = 0;
  for (let i = first; i <= last; i++) {
    let matched = 0;
    while (matched < text.length && after[i + matched] === text[matched]) matched++;
    if (matched === text.length) return true;
    steps += matched + 1;
    if (steps > READING_SEARCH_STEPS) return true;
  }
  return false;
}

/**
 * How many characters to delete to undo a failed injection, or null when no
 * deletion can be proven safe — in which case the field is left exactly as the
 * injection left it and the caller reports the failure instead of gambling with
 * the user's content.
 *
 * `input text` inserts at the cursor and backspace deletes at it, so N backspaces
 * remove exactly the N characters that landed, wherever in the field the cursor
 * sat: with the cursor between the two characters of "ab", injecting "XY" gives
 * "aXYb" and two backspaces give "ab" back (Pixel 6 / API 34). The question is
 * only how many of the characters present are ours.
 *
 * One model answers it. `input text` replaces the selection, so every reading of
 * the two captures has the shape
 *
 *     after === before[0, i) + landed + before[j, end)
 *
 * for a selection `[i, j)` — empty where the field had none — and a `landed` run
 * that is a SUBSEQUENCE of `text`, since dropped-keystroke corruption only ever
 * deletes events, never reorders or invents them. `landed.length` is what this
 * call put in the field, so it is the deletion count that reading implies.
 *
 * Where every reading names the same count, that count is proven. Where two
 * disagree, nothing is: acting on either deletes characters the other says are the
 * user's. The overlap is not exotic. A hint baseline (`FocusedField.text`) can
 * share an edge with the typed text — hint `https://` under `https://example.com`
 * — and reading the growth as this call's whole contribution deletes too few, the
 * retype appends onto the residue, and the doubled `https://https://…` is shaped
 * precisely to satisfy `classifyTypedText`'s first branch: reported `landed`, with
 * no note, and greened by the flow `type` gate.
 *
 * Two properties fall out of the model rather than needing guards. `landed` is a
 * subsequence of `text`, which `assertTypeableAndroidText` restricts to printable
 * ASCII, so a deleted run can never hold a character the FIELD put there — which
 * matters because `KEYCODE_DEL` deletes a whole grapheme cluster
 * (`BaseKeyListener.getOffsetForBackspaceKey`) while the count is in UTF-16 code
 * units, so a field that rewrites ":)" into an emoji would get two presses for one
 * grapheme. And a field that only ever LOST characters offers readings that
 * disagree, so it is refused rather than emptied of the user's surviving text.
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
      // Every pair costs a step, not only the ones that reach the scan: on a field
      // of one repeated character the arms below skip most readings without
      // reading anything.
      if (--steps < 0) return null;
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
      steps -= scanned;
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
 * reading, so a search over readings that read nothing still ends. Every offset of
 * the common prefix opens a reading per selection end, so the work grows with the
 * field length times the text length — synchronous CPU on the tool-server's only
 * thread, on a string a `describe` will happily hand back at 100 kB. Exhausting
 * the cap refuses the repair, which is the answer an ambiguous reading gets
 * anyway.
 */
const READING_SEARCH_STEPS = 2_000_000;

/**
 * Whether deleting one contiguous run of `gap` characters from `long` yields
 * `short`.
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
 * The subsequence test above, plus how much of `source` it had to read — the walk
 * stops on the character that completes `candidate`. That count is what
 * `plannedUndoDeletions` charges its budget.
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

async function injectInChunks(serial: string, text: string, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < text.length; i += REPAIR_CHUNK_CHARS) {
    if (i > 0) await sleep(REPAIR_CHUNK_DELAY_MS);
    abortRepair(signal, `${i} of ${text.length} characters retyped`);
    await injectAndroidText(serial, text.slice(i, i + REPAIR_CHUNK_CHARS));
  }
}

/**
 * Stop a repair the caller has given up on. The dropped socket that cancels it is
 * exactly what makes the MCP adapter re-POST the identical body, so a repair that
 * keeps typing interleaves its chunks with the replay's. Reports its progress
 * because the field is left part-way through a delete and a retype.
 */
function abortRepair(signal: AbortSignal | undefined, progress: string): void {
  if (signal?.aborted) throw repairAbortError(`${progress}, the field is part-way repaired`);
}

/** Named `AbortError` as the gesture tools name theirs, and read back at the repair's catch. */
function repairAbortError(detail: string, cause?: unknown): Error {
  const err = new Error(`keyboard repair aborted - ${detail}`);
  err.name = "AbortError";
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** Reports each batch as it goes out, so a failure can be described by what was sent. */
async function deleteTrailing(
  serial: string,
  count: number,
  onSent: (batch: number) => void,
  signal?: AbortSignal
): Promise<void> {
  for (let remaining = count; remaining > 0; remaining -= DELETE_KEYCODES_PER_CALL) {
    abortRepair(signal, `${count - remaining} of ${count} backspaces sent`);
    const batch = Math.min(remaining, DELETE_KEYCODES_PER_CALL);
    await injectAndroidKeycodeRepeated(serial, KEYCODE_BACKSPACE, batch);
    onSent(batch);
  }
}

/**
 * Advisory prose for every outcome that needs a caveat. No note contains the
 * field's text, so a `keyboard` call that typed a resolved `{{secret:…}}` cannot
 * echo the plaintext back — and there is NO backstop: `../index.ts` deliberately
 * does not substitute over `note` (it would rewrite ordinary words on healthy
 * calls and swallow the counts these notes exist to report, while matching whole
 * values only). A note that starts quoting what the field holds is a plaintext
 * leak. The character counts DO reveal the value's length, as `keys` already does,
 * so this bounds the leak rather than eliminating it; on a flow `type:` step the
 * note travels further than `keys`, riding the step's `warning` where a directive
 * step carries no `result` (see `flow-run.ts`).
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

// Something HAS focus, just not a view this check can read back. Kept apart from
// the note above, whose "tap the field first" would re-tap a field that already
// had focus.
function unrecognisedFocusNote(className: string): string {
  return (
    `${UNVERIFIED_PREFIX}: the view holding input focus (\`${className}\`) is not one this check ` +
    "can read back — its class is neither an `EditText` nor an `AutoComplete` subclass, which a " +
    "custom editor or a `WebView` that does not expose its inputs can be. Focus was NOT the " +
    "problem, so do not re-tap the field; the text was typed and may well have landed. Read the " +
    "field with `describe` to confirm."
  );
}

// A truncated capture can stop before the walk reaches the field, so "nothing had
// focus" is not a conclusion the read supports.
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

// The causes are named together because the read cannot tell them apart — see
// `isSameField`.
const FOCUS_MOVED_REASON =
  "the focused field is no longer the one the text was typed into, so that " +
  "field could not be checked — either input focus moved to another field while the text was " +
  "being typed, in which case the text may have been split across both, or the field could not be " +
  "matched again: it moved clear of where it was (a list scrolled by more than a row does this) AND " +
  "its `resource-id` could not identify it — absent, shared with a neighbour as an OTP form's boxes " +
  "are, or unprovable because the capture was truncated. Read the screen with `describe` before continuing.";

// A prefix rather than a whole reason: `misdirected` matches on it.
const UNRECOGNISED_FOCUS_AFTER_PREFIX = "the view holding input focus once the text had been typed";

function unrecognisedFocusAfterReason(className: string): string {
  return (
    `${UNRECOGNISED_FOCUS_AFTER_PREFIX} (\`${className}\`) is not one this check can read back ` +
    "— a custom editor or a `WebView` that does not expose its inputs can be one — so the field " +
    "it started in could not be checked. Read the screen with `describe` before continuing."
  );
}

// Nothing editable holds focus at all now: there is no second field for the text
// to have been split across, so "moved" would send the agent looking for one.
const FOCUS_LOST_REASON =
  "no editable field held input focus once the text had been typed, so the " +
  "field it started in could not be checked. Read the screen with `describe` before continuing.";

// Two editable views reporting focus at once (see `findFocused`). Guessing which
// one takes typing reads a burst that landed elsewhere as a total failure, and the
// repair then retypes the whole string into the field that DID receive it.
const CONTENDED_FOCUS_NOTE =
  `${UNVERIFIED_PREFIX}: more than one editable view reported input focus, which is what an open ` +
  "dialog over another window looks like, and the dump does not say which of them takes typing. " +
  "The text was typed. Read the field with `describe` to see what it holds.";

// The call succeeded and returned a hierarchy holding nothing, which says as
// little about focus as a truncated one does.
const EMPTY_CAPTURE_NOTE =
  `${UNVERIFIED_PREFIX}: the screen read came back with no windows in it, which a screen ` +
  "mid-transition or a display that has gone off does, so there was nothing to read the field " +
  "from. This says nothing about whether the text landed — read the field with `describe` to " +
  "confirm.";

const EMPTY_CAPTURE_AFTER_REASON =
  "the screen read came back with no windows in it once the text had been " +
  "typed, so the field it started in could not be found again. Read the field with `describe` " +
  "to see what it holds.";

const CONTENDED_FOCUS_AFTER_REASON =
  "more than one editable view reported input focus once the text had been " +
  "typed, so the field it started in could not be told from another window's. Read the screen " +
  "with `describe` before continuing.";

// A capture that stopped before reaching the field must not be reported as a
// focus change.
const TRUNCATED_AFTER_REASON =
  "the screen has more elements than one capture returns, so the read-back " +
  "was truncated before the field could be found again. Read the field with `describe` to see " +
  "what it holds.";

const MASKED_AFTER_REASON =
  "the focused field masks its input now, though it did not when the text " +
  "was typed — a password reveal toggle, or a field that masks once it holds something. It reads " +
  "back as bullets rather than characters, so there is nothing to compare, and reading a " +
  "credential back to compare it is what typing a `{{secret:…}}` placeholder exists to avoid.";

/**
 * Close a blocked read-back with what the call did to the field. The repair
 * backspaces and retypes BEFORE the confirming read, so every one of these
 * outcomes is reachable with the field already modified, where "nothing was
 * retyped" would be false about a destructive action.
 */
function blockedNote(reason: string, deleted: number | null): string {
  if (deleted === null) return `${UNVERIFIED_PREFIX}: ${reason} Nothing was retyped.`;
  return `${UNCONFIRMED_REPAIR_PREFIX}: ${reason} ${retypedClause(deleted)}${misdirected(reason)}`;
}

/**
 * `adb input` goes to whatever holds focus at the moment it runs, so a focus
 * change before the repair sent the backspaces and the retype somewhere else —
 * the worst state this module can leave behind, while `retypedClause` beside these
 * asserts the field WAS modified. Exactly one blocked reason establishes that (the
 * field masking its input NOW, which found and matched it first), so every other
 * one has to say where those key events may have gone instead.
 */
function misdirected(reason: string): string {
  if (reason === MASKED_AFTER_REASON) return "";
  if (reason === FOCUS_MOVED_REASON) {
    return (
      " If focus moved before the repair rather than during the read, those key events reached " +
      "the field that holds focus now, not the one the text was typed into."
    );
  }
  if (reason === FOCUS_LOST_REASON) {
    return (
      " If focus was already gone when the repair ran, those key events reached whatever the app " +
      "had focused instead, or nothing at all."
    );
  }
  if (reason.startsWith(UNRECOGNISED_FOCUS_AFTER_PREFIX)) {
    return (
      " If that view held focus before the repair rather than taking it during the read, those " +
      "key events reached it rather than the field the text was typed into."
    );
  }
  if (reason === CONTENDED_FOCUS_AFTER_REASON) {
    return (
      " If the second window held focus while the repair ran, those key events reached its field " +
      "rather than the one the text was typed into."
    );
  }
  // The reads that never saw the field: one that failed, one that came back empty,
  // one truncated before it got there.
  return (
    " The read that would have shown where those key events went never reached that field, so it " +
    "does not place them in it either."
  );
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

// The four readings `classifyTypedText` calls ambiguous. Acting on one is what
// would double the text or overwrite a field that is already right.
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

// The same verdict reached AFTER the repair ran, and equally not collapsed into
// `verified: false`: a repair that restored the field lands here — an empty phone
// box that took "555" of "5551234567" and reformats the retyped number to
// "(555) 123-4567" — so reporting a failure would state the opposite of what
// happened. The field WAS modified, hence a sentence of its own.
function indeterminateAfterRepairNote(deleted: number): string {
  return `${INDETERMINATE_BASE} ${retypedClause(deleted)} Read the field with \`describe\` to confirm.`;
}

/**
 * Three readings produce this and the read-back cannot tell them apart, so the
 * note carries all three rather than asserting the likeliest — and retyping in
 * chunks fixes only the first. A whole replacement never arrives here:
 * `replacedSelection` calls that `indeterminate`.
 */
function mismatchNote(typed: number, present: number, repaired: boolean): string {
  return (
    `The typed text did NOT land in the focused field: ${typed} ` +
    `character${typed === 1 ? "" : "s"} ${typed === 1 ? "was" : "were"} typed and the field now ` +
    `holds ${present} in total. That total counts whatever the field already showed — an empty ` +
    "field reads back as its hint — so it is not a count of how many characters were lost" +
    (repaired
      ? ", and retyping it in smaller chunks did not fix it either"
      : ", and the field could not be safely restored, so nothing was retyped") +
    ". Either Android's key-event burst lost characters on a field that re-renders " +
    "per keystroke, or the field rejects or reformats what is typed into it (a " +
    "digits-only field, an input mask, a maxLength) — or part of it replaced a " +
    "selection, which removes the selected run as well. Read the field with " +
    "`describe` to see what it holds, then either type in shorter pieces or send a " +
    "value the field accepts."
  );
}

// The repair runs backspaces before retyping, so this is the one path that can
// leave the field holding LESS than when the call started.
function repairFailedNote(deleted: number, planned: number): string {
  if (planned === 0) {
    return (
      "The typed text did not land, and the repair could not be completed: nothing had to be " +
      "deleted first, and the retype did not finish. The field may hold anything from what it " +
      "held before this call to that plus a truncated copy of the text. Read it with `describe` " +
      "and retype from a known state."
    );
  }
  if (deleted === 0) {
    return (
      "The typed text did not land, and the repair could not be completed: the first batch of " +
      "backspaces was not confirmed to have gone out. The field may hold anything from what it held when this call " +
      "read it back to that with part of the typed text removed. Read it with `describe` and " +
      "retype from a known state."
    );
  }
  return (
    `The typed text did not land, and the repair could not be completed: ${deleted} ` +
    `character${deleted === 1 ? "" : "s"} ${deleted === 1 ? "was" : "were"} removed, or partly ` +
    "removed, and the retype did not finish. The field may hold anything from less than it did " +
    "before this call to a truncated copy of the text. Read it with `describe` and retype from a " +
    "known state."
  );
}

// A repair that WORKED still changed the field beyond what the caller asked for:
// the backspaces and the chunked retype are app-visible events — a search box
// re-queries on each one, a recipients field drops the previous chip on a
// backspace at position 0, an OTP box steps focus back a slot.
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
 * `clearCache: true` is mandatory: the helper holds one long-lived UiAutomation
 * connection whose `AccessibilityNodeInfo` cache serves stale text — the reason
 * `flows/flow-android-tree.ts` passes it too — and without it the "after" read can
 * return the pre-typing value and the verification is theatre.
 *
 * `maxNodes` matches the flow tree's cap for the same reason: the helper's 5000
 * default truncates a dense screen mid-walk, and a capture that stops before the
 * focused field is reached is indistinguishable from a screen with no focused
 * field. `truncated` is returned so that case can be reported as the unknown it
 * is.
 */
const READ_MAX_NODES = 12_000;

async function readFocusedField(devtools: AndroidDevtoolsApi): Promise<{
  field: FocusedField | null;
  focusedClass: string | null;
  contendedFocus: boolean;
  empty: boolean;
  truncated: boolean;
}> {
  const { xml, truncated } = await devtools.getHierarchy({
    clearCache: true,
    maxNodes: READ_MAX_NODES,
  });
  const found = findFocused(xml);
  // A capture cut short cannot show an id to be unique: the helper writes nodes in
  // document order, so the view that shares it may be one it never reached. It
  // cannot rule out a second focused view either, so the dialog case above stays
  // open on a screen dense enough to truncate. Below API 34 the helper emulates
  // `clearCache` by refreshing each node and drops the subtree of any that fails,
  // without the flag, so a field re-rendering under the burst can go missing from a
  // capture that reports itself complete.
  if (found.field && truncated) found.field.idShared = true;
  return { ...found, truncated };
}

/**
 * Type `text` into the focused field and prove it landed.
 *
 * Injects exactly once on every path that reaches the injection — the text is
 * typed whether or not it can be verified, and only a cancellation seen before
 * the first keystroke types nothing — plus at most one chunked re-injection when
 * the first attempt is caught having dropped characters. Two attempts total: a
 * field that drops events under both a single burst and a slow chunked cadence is
 * not failing for cadence reasons (an input mask, autocorrect, a maxLength, a
 * field rejecting characters), so a third would add latency to the same wrong
 * answer.
 *
 * Never throws for a verification problem, including one raised by the repair
 * itself: by the time anything here can go wrong the keystrokes are already on the
 * device, so a thrown error would tell the agent the typing failed when it may
 * well have succeeded. Every verification outcome comes back as `verified: true`,
 * `verified: false`, or an absent `verified` with a note. Two things do throw:
 * errors from the injection the call is actually FOR, and a cancelled `signal` — a
 * run the caller gave up on is owed a skip, not a finding about the app.
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
  // take minutes, so the caller can be gone before anything would be typed —
  // nothing is waiting for those keystrokes and they would land in whatever holds
  // focus by now.
  signal?.throwIfAborted();
  if (!devtools) {
    await injectAndroidText(serial, text);
    signal?.throwIfAborted();
    return { note: HELPER_UNAVAILABLE_NOTE };
  }

  // The helper closes a socket left idle for 60 s (SOCKET_READ_TIMEOUT_MS in
  // SnapshotInstrumentation.java) and every stretch of adb work below is silent on
  // it. The close tears down the whole service, so the reads below would fail AND
  // every other tool sharing the helper would pay a cold start.
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
  // Every path that gives up on the read-back still types, then reports why.
  const typedWithout = async (note: string): Promise<KeyboardVerification> => {
    await injectAndroidText(serial, text);
    signal?.throwIfAborted();
    return { note };
  };
  const baseline = await readFocusedField(devtools).catch(() => null);
  // A whole hierarchy dump stands between the check above and the first
  // keystroke, so the caller can give up inside it. Past this point the text is
  // typed on every path, including the one that gives up on reading the field.
  signal?.throwIfAborted();
  if (!baseline) return typedWithout(blockedNote(READ_FAILED_REASON, null));
  const {
    field: before,
    focusedClass: beforeFocusedClass,
    contendedFocus: beforeContended,
    empty: beforeEmpty,
    truncated: beforeTruncated,
  } = baseline;
  if (beforeContended) return typedWithout(CONTENDED_FOCUS_NOTE);
  if (!before) {
    if (beforeEmpty) return typedWithout(EMPTY_CAPTURE_NOTE);
    if (beforeTruncated) return typedWithout(TRUNCATED_READ_NOTE);
    return typedWithout(
      beforeFocusedClass === null
        ? NO_FOCUSED_FIELD_NOTE
        : unrecognisedFocusNote(beforeFocusedClass)
    );
  }
  if (before.password) return typedWithout(PASSWORD_FIELD_NOTE);

  await injectAndroidText(serial, text);

  const after = await readAfter(devtools, before, null);
  // Past here the call reports on the field, and a caller that gave up is owed a
  // skip instead of a report: the three step gates key on `verified: false`, while
  // a rejection reaches all three as the uniform aborted skip (`run-sequence` has
  // no verdict field, so it stops without recording the step). This check also
  // stands in for the repair below, which must not START once the caller has gone:
  // it deletes before it retypes, and the MCP adapter replays a call it abandoned.
  signal?.throwIfAborted();
  if (after.blocked) return after.blocked;
  const verdict = classifyTypedText(before.text, after.field.text, text);
  if (verdict === "landed") return { verified: true };
  if (verdict === "indeterminate") return { note: INDETERMINATE_NOTE };

  const deletions = plannedUndoDeletions(before.text, after.field.text, text);
  if (deletions === null) {
    return { verified: false, note: mismatchNote(text.length, after.field.text.length, false) };
  }
  let repairFailed = false;
  let deleted = 0;
  try {
    await deleteTrailing(serial, deletions, (batch) => (deleted += batch), signal);
    await injectInChunks(serial, text, signal);
  } catch (err) {
    // A repair that stopped because the caller did is a cancellation, not a
    // transport failure: `repairFailedNote` describes the field to a caller, and
    // this one is gone. As in gesture-drag, an adb failure that coincides with the
    // cancel rides along as the abort's `cause` rather than replacing it — a
    // cancelled call is exactly when the device connection can be going away.
    if (signal?.aborted) {
      throw err instanceof Error && err.name === "AbortError"
        ? err
        : repairAbortError("the device call failed as the caller gave up", err);
    }
    repairFailed = true;
  }
  // Covers an abort that landed after the last chunk, which the loops above
  // cannot see.
  signal?.throwIfAborted();
  if (repairFailed) {
    // Counting the backspaces that went out rather than the ones planned, since
    // the call that failed may be the first.
    return { verified: false, note: repairFailedNote(deleted, deletions) };
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
 * Re-read the field the call started in, or the reason it cannot be compared.
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
  // landed, and the field was then backspaced and retyped. So the verdict travels
  // with the note — an absent one is the pass value at all three step gates, which
  // would submit exactly the field with the most evidence against it.
  const blocked = (reason: string): { blocked: KeyboardVerification } => ({
    blocked: {
      ...(deleted === null ? {} : { verified: false }),
      note: blockedNote(reason, deleted),
    },
  });

  let field: FocusedField | null;
  let focusedClass: string | null;
  let contendedFocus: boolean;
  let empty: boolean;
  let truncated: boolean;
  try {
    ({ field, focusedClass, contendedFocus, empty, truncated } = await readFocusedField(devtools));
  } catch {
    return blocked(READ_FAILED_REASON);
  }
  if (contendedFocus) return blocked(CONTENDED_FOCUS_AFTER_REASON);
  if (!field) {
    // The same three distinctions the baseline read draws.
    if (empty) return blocked(EMPTY_CAPTURE_AFTER_REASON);
    if (truncated) return blocked(TRUNCATED_AFTER_REASON);
    return blocked(
      focusedClass === null ? FOCUS_LOST_REASON : unrecognisedFocusAfterReason(focusedClass)
    );
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
