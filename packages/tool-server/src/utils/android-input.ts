/**
 * Android key / text / button injection over `adb shell input`.
 *
 * The bundled simulator-server injects keys as USB-HID events, which the guest
 * only receives when the AVD exposes a hardware keyboard (`hw.keyboard = yes`).
 * That is the default, but CI / headless AVDs are frequently created with
 * `hw.keyboard = no` (and `hw.mainKeys = no`), where those HID events are
 * silently dropped by the guest. Because the simulator-server transport is
 * fire-and-forget, the `keyboard` and `button` tools then reported success while
 * injecting nothing — see the `button` tool's own note about silent no-ops, and
 * https://github.com/software-mansion/argent/issues/449.
 *
 * `adb shell input text` / `input keyevent` go through Android's InputManager, so
 * they land regardless of `hw.keyboard` — on emulators (any config) and physical
 * devices alike — and a non-zero exit surfaces as a thrown error (runAdb rewraps
 * it) instead of a silent success. Touch injection is unaffected and stays on the
 * simulator-server; only key/text/button events move to this transport.
 */
import { FAILURE_CODES } from "@argent/registry";
import {
  attrIsTrue,
  parseUiAutomatorXml,
} from "../tools/describe/platforms/android/uiautomator-parser";
import { adbShell, shellQuote } from "./adb";
import { dumpAndroidUiXml } from "./android-ui-dump";
import { InvalidToolInputError } from "./capability";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// android.view.KeyEvent keycodes for the keyboard tool's named-`key` vocabulary
// (must cover every key in ../tools/keyboard/key-codes.ts NAMED_KEYS).
export const ANDROID_NAMED_KEYCODES: Record<string, number> = {
  "enter": 66, // KEYCODE_ENTER
  "return": 66, // alias of enter
  "escape": 111, // KEYCODE_ESCAPE
  "esc": 111, // alias of escape
  "backspace": 67, // KEYCODE_DEL (backspace: deletes the char before the cursor)
  // `delete` aliases backspace, not forward-delete: the shared HID vocabulary in
  // key-codes.ts (NAMED_KEYS) maps both `backspace` and `delete` to usage 42
  // (Keyboard DELETE/Backspace), so iOS types `delete` as a backspace. A named
  // key must mean the same thing on every platform, so map it to KEYCODE_DEL (67)
  // here too rather than KEYCODE_FORWARD_DEL (112).
  "delete": 67, // KEYCODE_DEL (alias of backspace — see note above)
  "tab": 61, // KEYCODE_TAB
  "space": 62, // KEYCODE_SPACE
  "arrow-up": 19, // KEYCODE_DPAD_UP
  "arrow-down": 20, // KEYCODE_DPAD_DOWN
  "arrow-left": 21, // KEYCODE_DPAD_LEFT
  "arrow-right": 22, // KEYCODE_DPAD_RIGHT
  // F1..F12 are KEYCODE_F1 (131) .. KEYCODE_F12 (142), contiguous.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 131 + i])),
};

// android.view.KeyEvent keycodes for the button tool's Android hardware buttons
// (must cover BUTTONS_BY_PLATFORM.android in ../tools/button/index.ts).
export const ANDROID_BUTTON_KEYCODES: Record<string, number> = {
  home: 3, // KEYCODE_HOME
  back: 4, // KEYCODE_BACK
  power: 26, // KEYCODE_POWER
  volumeUp: 24, // KEYCODE_VOLUME_UP
  volumeDown: 25, // KEYCODE_VOLUME_DOWN
  appSwitch: 187, // KEYCODE_APP_SWITCH
};

// `input text` receives the string as a single argv token (we `shellQuote` it, so
// the device shell doesn't split on spaces). It reliably types only printable
// ASCII: spaces and punctuation work, but a newline can't be represented, emoji
// crash `InputShellCommand.sendText` with a NullPointerException, and other
// non-ASCII (accented letters, CJK) is silently dropped by the virtual
// KeyCharacterMap. Reject anything outside printable ASCII up front, naming the
// offending character, so the caller gets a clear error instead of a cryptic
// crash or a silently-wrong field. (`%` is handled separately — see
// `splitForVerbatimPercent` — because it is typeable but needs escaping.)
export function assertTypeableAndroidText(text: string): void {
  // Keep the newline case as its own message: it's the one non-typeable char
  // with an obvious alternative, so point the caller at it.
  if (/[\n\r]/.test(text)) {
    // Well-typed but not injectable: a caller input error (HTTP 400 via
    // InvalidToolInputError), not an internal server fault (500). A newline is
    // a character this backend can't type, so it buckets with the other
    // un-typeable-character rejections under KEYBOARD_CHARACTER_UNSUPPORTED —
    // the same telemetry code the iOS/chromium backends use (#420).
    throw new InvalidToolInputError(
      // Advice must hold on every path sharing this guard: named keys work on
      // phones/tablets but are rejected on a TV target (typeTv), where the
      // equivalent is the tv-remote select press.
      "keyboard text must not contain a newline on Android; press enter separately " +
        'instead (key: "enter" on a phone or tablet, tv-remote select on a TV)',
      {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "keyboard_text_newline_android",
        error_kind: "unsupported",
      }
    );
  }
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      // Same KEYBOARD_CHARACTER_UNSUPPORTED bucket as the iOS/chromium
      // backends' un-typeable-character rejections (#420), so telemetry for
      // this failure doesn't diverge by platform.
      throw new InvalidToolInputError(
        `keyboard text can only contain printable ASCII on Android; character "${char}" ` +
          `(U+${hex}) can't be typed via \`adb input text\` — emoji crash it and other ` +
          `non-ASCII (accented, CJK) is silently dropped. Remove it.`,
        {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_android",
          error_kind: "unsupported",
        }
      );
    }
  }
}

// `input text`'s `InputShellCommand.sendText` rewrites the two-char sequence `%s`
// into a single space (and does NOT unescape `%%` back to `%`), so a naive single
// `input text "100%safe"` silently types `100 afe`. Split the text so that every
// `%` is the LAST character of its segment and issue one `input text` per segment:
// within a segment a `%` is therefore never immediately followed by `s`, so
// sendText can't fire that transform, and the segments concatenate on-device to
// the exact input. A `%`-free string yields a single segment (one `input text`),
// identical to before.
//   "100%safe" → ["100%", "safe"] → "100%" + "safe" = "100%safe"
//   "%s"       → ["%", "s"]        → "%" + "s"       = "%s"
//   "%%"       → ["%", "%"]        → "%" + "%"       = "%%"
//
// Every `input text` sink flows through `injectAndroidText` below — the phone
// keyboard path directly, the Android-TV blueprint per space-free word — so
// this workaround stays single-sourced.
function splitForVerbatimPercent(text: string): string[] {
  // Each `[^%]*%` chunk ends at (and includes) a `%`; the trailing `[^%]+` catches
  // the tail after the final `%`. Every `%` thus lands at a segment boundary.
  return text.match(/[^%]*%|[^%]+/g) ?? [];
}

// `input` opens the app-process VM per call, so it is not instant; 15s comfortably
// covers a single text/keyevent injection on a slow CI emulator while still
// bounding a hung adb child.
const ADB_INPUT_TIMEOUT_MS = 15_000;

/** Type text into the focused field via `adb shell input text`. No-op for "". */
export async function injectAndroidText(serial: string, text: string): Promise<void> {
  assertTypeableAndroidText(text);
  // One `input text` per segment so a `%` never precedes an `s` on the device (see
  // `splitForVerbatimPercent`); `%`-free text is a single call, as before. An
  // empty string yields no segments (`splitForVerbatimPercent("")` → []), so this
  // is a no-op for "" without a separate guard.
  for (const segment of splitForVerbatimPercent(text)) {
    await adbShell(serial, `input text ${shellQuote(segment)}`, {
      timeoutMs: ADB_INPUT_TIMEOUT_MS,
    });
  }
}

/** Press a single android.view.KeyEvent keycode via `adb shell input keyevent`. */
export async function injectAndroidKeycode(serial: string, keycode: number): Promise<void> {
  await adbShell(serial, `input keyevent ${keycode}`, { timeoutMs: ADB_INPUT_TIMEOUT_MS });
}

// Keycodes used by the clear (select-all + delete) sequence.
const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_A = 29;
const KEYCODE_DEL = 67;

/**
 * Wall-clock budget for one whole clear, shared across every adb round trip it
 * makes.
 *
 * A clear is up to four sequential adb calls plus an in-process backoff: the
 * `keycombination` probe, then on a legacy level a `uiautomator dump`, a
 * DUMP_RETRY_BACKOFF_MS wait, a second dump (see {@link readHierarchy}) and the
 * delete run. `text` / `key` injection still follows it inside the same
 * request. `keyboard` does not
 * declare `longRunning`, so the argent-mcp adapter applies its 30s per-request
 * fetch timeout to the lot (`FETCH_TIMEOUT_MS`, mcp-server.ts) — which means the
 * legs CANNOT each be sized against 30s independently, or their worst cases sum
 * past it and the client abandons the request while adb keeps deleting on the
 * device. So they share one deadline instead.
 *
 * 20s covers the slowest path measured on API 30 (a ~2s dump plus 6.9s of
 * deletes against the live-filtering Settings search box) with room to spare.
 * It bounds the CLEAR only: `text` and `key` keep their own ADB_INPUT_TIMEOUT_MS
 * caps, which is the pre-existing budget for a call without a clear. So this
 * stops the clear from blowing the request budget on its own; it does not turn
 * the whole tool call into one deadline, which would mean threading it through
 * the text/key injectors the Android-TV blueprint shares.
 */
const ANDROID_CLEAR_BUDGET_MS = 20_000;

/**
 * Held back from the read legs (probe, dump) so the delete run always has time
 * to finish once it starts.
 *
 * Without a reservation the dump's own cap is the whole remaining budget, so a
 * slow `uiautomator` can spend all of it and the delete run then starts against
 * a few hundred milliseconds. Which leg to starve is not symmetric: a squeezed
 * dump degrades to BLIND_DELETE_COUNT, which is merely less exact, while a
 * squeezed delete run risks a partly-deleted field.
 *
 * Sized to cover the largest run MAX_DELETE_COUNT permits at the worst rate ever
 * measured (~7.3s — see there), with headroom. The read legs keep the remaining
 * ~9s, which covers a warm probe plus two dumps.
 */
const DELETE_RUN_RESERVE_MS = 11_000;

/**
 * Timeout for the next leg of a clear: whatever is left of the shared budget.
 *
 * `reserveMs` is withheld so an earlier leg cannot consume what a later one
 * needs. The shared deadline is deliberately the only bound: the budget is what
 * actually has to hold, and a second per-leg cap on top of it could only ever
 * bind before the budget did, which is the sizing the whole block exists to
 * avoid.
 *
 * Floored at 1s rather than 0 because `runAdb` forwards this straight to
 * `execFile`'s `timeout`, and `??`-defaulting preserves a `0` — which Node reads
 * as NO timeout, not as an instant one. An already-overrun budget would
 * therefore hand the last leg an UNBOUNDED adb child rather than failing it
 * fast. 1s keeps every leg bounded and still lets a merely slow device finish a
 * warm call.
 */
function clearLegTimeout(deadline: number, reserveMs = 0): number {
  return Math.max(1_000, deadline - Date.now() - reserveMs);
}

export interface AndroidClearOptions {
  /**
   * Read the view hierarchy the way `describe` prefers to, or return undefined
   * when that source is not available right now.
   *
   * This exists because the device serves exactly ONE UiAutomation connection
   * and argent's own `android-devtools` helper holds it — measured on a live API
   * 30 emulator at 61.2s per `describe`, during which every `uiautomator dump`
   * comes back as a bare `Killed` with adb still exiting 0. That is not a race
   * a backoff can wait out, and the cost is not a slow clear: the measurement
   * fails, {@link clearByDeleting} falls to BLIND_DELETE_COUNT, and a field
   * longer than that keeps its head while the tool reports `cleared: true`.
   * Measured end to end on that emulator, 6/6 — a 200-character field left 72
   * characters of residue with the new text appended to it, and the
   * MAX_DELETE_COUNT refusal that would otherwise have caught it never fired.
   * `describe` → tap → `keyboard` is the ordinary call order, so the window is
   * not an edge case.
   *
   * Asking the holder for the hierarchy instead of racing it removes the
   * contention outright, and skips a dump plus the retry backoff when it works.
   *
   * Two consequences of reading from the helper rather than a compressed dump,
   * both measured on the same API 30 screen:
   *
   *   - it sees MORE windows (219 nodes across the app, systemui and the IME,
   *     against the dump's 7). The `EditText` filter still excludes the IME's
   *     own focused node, but a focused EditText in an overlay window is now
   *     visible to the measurement where it was not before — which is the
   *     "belongs to a different focused field" hazard the MAX_DELETE_COUNT
   *     refusal already warns about, reachable slightly more often.
   *   - a helper that is ALIVE but cannot answer inside the budget still falls
   *     to BLIND_DELETE_COUNT, and a long field is then truncated exactly as it
   *     was before this option existed. Not a regression — a raw dump fails
   *     identically in that state (verified: `Killed` in both) — but it is the
   *     one hole this does not close. Reaching it took root + SIGSTOP, or 250
   *     synthetic concurrent RPC sockets; the tool-server serialises its own
   *     calls on one client socket, so ordinary usage does not produce it.
   */
  readHierarchy?: () => Promise<string | undefined>;
}

/**
 * Empty the focused text field: select its whole contents, then delete.
 *
 * Ctrl+A is the Android select-all chord (it is what a hardware keyboard sends),
 * and `input keycombination` is the only `input` subcommand that can hold one
 * key while pressing another. Verified on a native `EditText` (Settings search)
 * and a React Native `TextInput` (Bluesky sign-in) — the field empties, the
 * placeholder returns and focus is retained.
 *
 * `keycombination` is a recent `input` subcommand; older levels do not have it
 * (measured absent on API 30, present on API 34 and 36) — and its absence
 * CANNOT be detected by exit code. `input` reports an unknown subcommand by
 * throwing IllegalArgumentException, which `BaseCommand` catches and turns into
 * a usage dump, so the process still **exits 0**:
 *
 *     $ adb shell input keycombination 113 29   # API 30
 *     Usage: input [<source>] [-d DISPLAY_ID] <command> [<arg>...]
 *     $ echo $?
 *     0
 *
 * Detecting this by catching a throw would therefore never fire: the select-all
 * would silently do nothing, the DEL below would delete exactly ONE character,
 * and the tool would report `cleared: true` — the same silent-no-op class as
 * issue #449. So the marker is read out of the command's OUTPUT instead.
 *
 * Two output shapes have to be recognised because `input` words the complaint
 * differently across levels: API 30 prints the `Usage: input …` dump, and the
 * levels that phrase it as `Unknown command: …` do so for any subcommand they
 * do not have (measured by feeding them a nonsense one — they DO have
 * `keycombination`, so they never emit it for this call). Matching both keeps
 * the guard correct on a level that has neither the subcommand nor API 30's
 * wording.
 *
 * The `2>&1` is load-bearing. Which stream carries the complaint also varies —
 * API 30 writes its usage dump to STDERR — and `adbShell` returns stdout only,
 * so without the redirect an API 30 device looks exactly like a success and the
 * one-character delete ships. Redirecting on the device folds both into the
 * stream we can see. Verified that a device which DOES support the subcommand
 * prints nothing on either stream, so this cannot false-reject.
 *
 * A thrown error is left to propagate as the genuine transport failure it is.
 *
 * On a level without `keycombination` the clear falls back to
 * {@link clearByDeleting}.
 */
export async function injectAndroidClear(
  serial: string,
  options: AndroidClearOptions = {}
): Promise<void> {
  // One deadline for every leg below — see ANDROID_CLEAR_BUDGET_MS.
  const deadline = Date.now() + ANDROID_CLEAR_BUDGET_MS;
  const out = await adbShell(
    serial,
    `input keycombination ${KEYCODE_CTRL_LEFT} ${KEYCODE_A} 2>&1`,
    { timeoutMs: clearLegTimeout(deadline, DELETE_RUN_RESERVE_MS) }
  );
  if (/unknown command|usage: input/i.test(out)) {
    await clearByDeleting(serial, deadline, options.readHierarchy);
    return;
  }
  await adbShell(serial, `input keyevent ${KEYCODE_DEL}`, {
    timeoutMs: clearLegTimeout(deadline),
  });
}

const KEYCODE_MOVE_END = 123;

// Extra backspaces beyond the field's measured length. The measurement and the
// delete run are two separate device round trips reading two different sources
// of truth — uiautomator's cached view text versus the editor's live buffer —
// so a small overshoot absorbs any skew between them (an in-flight IME
// composition, a field whose displayed text is shorter than its value).
// Backspace on an empty field is a no-op, so overshooting costs only key events.
const DELETE_MARGIN = 8;

// Used when the focused field's contents cannot be measured: no focused
// *editable* node in the dump, a password field (whose reported text is the
// mask, not the value), or a dump that failed outright. Covers any credential or
// single-line form field.
//
// This IS the fixed run the measurement exists to avoid, so it carries that
// shape's failure with it: a field longer than this PLUS DELETE_MARGIN — the
// count actually sent — keeps its head.
//
// It MUST NOT exceed MAX_DELETE_COUNT. An unmeasurable focused editable floors
// the measurement to this value rather than vanishing from it (see
// measureFocusedTextLength), so the blind count is what the length refusal
// compares — and if it sat above the limit, every unmeasurable field (every
// password field on these levels) would be refused, quoting this constant as
// though it were a length that had been measured. The refusal is `count >
// MAX_DELETE_COUNT`, so equality is allowed and `<=` is the relationship.
// `it("keeps the blind delete count under the length limit")` in
// test/keyboard-clear.test.ts pins it, because the two constants are otherwise
// edited independently and nothing else connects them.
export const BLIND_DELETE_COUNT = 120;

// Longest field this path will attempt; beyond it the clear is refused rather
// than started — see clearByDeleting.
//
// The cost model, from the measurements recorded in this file: one `input`
// invocation carries a constant VM start, plus per-keystroke work that is
// near-zero against an already-empty field (608 no-op deletes in 0.8s) and real
// against a field that reacts to every keystroke. The worst case measured is the
// live-filtering Settings search box on API 30 — 150 keys in 6.9s, i.e. ~46ms
// per key including the constant. So the count barely predicts the time on an
// ordinary field and dominates it on the worst one, and the limit has to be
// sized against the worst.
//
// 150 (+ DELETE_MARGIN = 158 keys) is ~7.3s at that rate, comfortably inside the
// DELETE_RUN_RESERVE_MS the run is guaranteed. It is still well past the
// single-line inputs this fallback serves — a login, a search box, a form field.
export const MAX_DELETE_COUNT = 150;

/**
 * Empty the focused field on an Android level whose `input` has no
 * `keycombination`: move the caret to the end of the line, then backspace over
 * the contents.
 *
 * The count is measured where it can be. A `uiautomator dump` is read first and
 * the focused editable node's `text` gives the number of characters to remove,
 * so this is not the fixed best-effort it would otherwise be — the failure mode
 * of a fixed run is that a longer field keeps its head and the typed text is
 * appended to that residue, which is precisely what `clear` exists to prevent.
 * Where the field cannot be measured it falls back to BLIND_DELETE_COUNT, which
 * IS such a fixed run: see {@link measureFocusedTextLength} for exactly when,
 * and BLIND_DELETE_COUNT for what it covers.
 *
 * Note the dump reports an EMPTY field's hint in the same `text` attribute (on
 * every level tested, including API 36, which carries no separate `hint`
 * attribute to tell them apart), so a measurement can be the placeholder rather
 * than real content. For the delete run that is harmless — it only makes the run
 * slightly longer than needed, and backspace on an empty field does nothing. It
 * is NOT harmless for the MAX_DELETE_COUNT gate below, which turns any
 * over-measurement into a refusal: an empty field whose placeholder is longer
 * than the limit is refused with a length it does not hold. Accepted rather than
 * fixed, because nothing in the dump distinguishes the two on the levels this
 * fallback serves, and the alternative (delete first, judge after) can only
 * discover a real over-long field by having already truncated it. A placeholder
 * that long is also not a shape these single-line fields take.
 *
 * Known limit, and the reason this is the fallback rather than the primary path:
 * `KEYCODE_MOVE_END` is end-of-LINE, not end-of-buffer, so a multi-line field
 * keeps whatever sits below the caret. Single-line inputs — every login, search
 * and form field — are emptied exactly.
 *
 * Measured on an API 30 emulator: 150 keys against the live-filtering Settings
 * search box took 6.9s wall-clock and emptied it; against an idle field the same
 * run is ~0.75s, since the cost is dominated by one `input` VM start.
 */
async function clearByDeleting(
  serial: string,
  deadline: number,
  preferredRead?: () => Promise<string | undefined>
): Promise<void> {
  const count =
    (await measureFocusedTextLength(serial, deadline, preferredRead)) ?? BLIND_DELETE_COUNT;
  const keys = count + DELETE_MARGIN;
  // Refuse BEFORE touching the field, and on length alone. Time is deliberately
  // not a second ground: the run is already bounded by DELETE_RUN_RESERVE_MS,
  // which the read legs above cannot spend, so "this call ran out of budget" has
  // no case of its own to reject. Predicting the run's duration instead of
  // capping its length cannot work here either — the per-key cost spans two
  // orders of magnitude between an idle field and a live-filtering one (see
  // MAX_DELETE_COUNT), and on the blind path there is no measured length to
  // predict from.
  if (count > MAX_DELETE_COUNT) {
    throw new InvalidToolInputError(
      `keyboard clear: a focused text field on this screen reports ${count} characters, more ` +
        `than this Android level can clear. Without \`input keycombination\` (added after API ` +
        `30) the only available clear is one backspace per character, which is too slow to ` +
        `finish reliably past ${MAX_DELETE_COUNT}. The count comes from the screen's view ` +
        `hierarchy, which reports an empty field's placeholder in the same attribute as its ` +
        `value and covers every window, so it may belong to a different focused field than ` +
        `the one you meant. Nothing was modified and nothing was typed. Clear the field with ` +
        `the app's own affordance, or use an emulator on a newer API level.`,
      {
        // Its own code rather than KEYBOARD_CLEAR_INEFFECTIVE: this is a
        // caller-fixable rejection (a 400) that changed nothing, whereas
        // INEFFECTIVE is an internal fault (a 500) after the edit was attempted.
        // Sharing one code would mix the two in any dashboard slicing on it.
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_FIELD_TOO_LONG,
        failure_stage: "keyboard_clear_too_long_android",
        error_kind: "unsupported",
      }
    );
  }
  const dels = Array.from({ length: keys }, () => KEYCODE_DEL).join(" ");
  // One invocation for the whole run: `input keyevent` accepts a keycode list.
  // No reserve withheld — this IS the leg the reserve was held for, so it gets
  // everything remaining. (Killing adb part-way does NOT stop the device:
  // measured on API 36, deletes already handed over keep landing, so an
  // interrupted run finishes anyway and the caller merely sees a spurious
  // error. The reserve is what keeps that from being the normal outcome.)
  await adbShell(serial, `input keyevent ${KEYCODE_MOVE_END} ${dels}`, {
    timeoutMs: clearLegTimeout(deadline),
  });
}

// The winner of a UiAutomation race holds the connection for the whole dump
// (measured 1.97-2.06s, 5/5), while the loser is rejected in ~0.27s. So an
// immediate retry re-races the same holder and fails too — measured 3/3, both
// attempts refused. Waiting out the holder first succeeded 3/3.
const DUMP_RETRY_BACKOFF_MS = 2_500;

// A dump takes ~2s, so a leg with less than this cannot produce one; attempting
// it anyway would spend the 1s floor out of the delete run's reserve for a
// result that cannot arrive.
const MIN_USEFUL_DUMP_MS = 2_500;

// Cap on the {@link AndroidClearOptions.readHierarchy} read. The helper answers
// a live RPC in well under a second, so this is generous — it exists only to
// bound a wedged one, and is deliberately far below that RPC's own 15s timeout
// so a hung helper still leaves the dump fallback a usable share of the budget.
const PREFERRED_READ_BUDGET_MS = 5_000;

/**
 * One `uiautomator dump`, retried once after a backoff when the device returns
 * no hierarchy.
 *
 * The device serves a single UiAutomation connection, so concurrent readers race
 * — with three dumps in flight, two came back as a bare `Killed` (adb still
 * exiting 0). `describe` reports that to the caller as a capture failure, but
 * here a failed read is silent: it degrades to the blind delete count, and a
 * field longer than that keeps its head while the tool reports `cleared: true`.
 * That is the corruption the measurement exists to prevent, so it is worth
 * waiting out the holder — two dumps plus the backoff still fit the read legs'
 * share of the budget.
 *
 * Returns undefined when neither attempt produced a hierarchy, or when there is
 * not enough budget left to try.
 *
 * `preferredRead` is tried first and is what makes the common case work at all:
 * the connection's usual holder is argent's own `android-devtools` helper, for
 * ~60s after every `describe`, and neither dump can win against that — see
 * {@link AndroidClearOptions}. A read that comes back without a hierarchy, or
 * throws, falls through to the dumps rather than failing the clear.
 */
async function readHierarchy(
  serial: string,
  deadline: number,
  preferredRead?: () => Promise<string | undefined>
): Promise<string | undefined> {
  // Withhold BOTH the delete run's reserve and one dump's worth of budget. The
  // helper's own `getHierarchy` RPC timeout is 15s — longer than this whole read
  // share — so an unbounded await would let a wedged helper spend the reserve
  // AND leave nothing for the fallback below, turning a slow helper into the
  // blind count this path exists to avoid. Losing the race just falls through to
  // the dump, which is what ran before the helper was consulted at all.
  const preferredBudgetMs = Math.min(
    PREFERRED_READ_BUDGET_MS,
    deadline - Date.now() - DELETE_RUN_RESERVE_MS - MIN_USEFUL_DUMP_MS
  );
  if (preferredRead && preferredBudgetMs > 0) {
    try {
      const xml = await Promise.race([
        preferredRead(),
        sleep(preferredBudgetMs).then(() => undefined),
      ]);
      if (xml && xml.includes("<hierarchy")) return xml;
    } catch {
      // The helper is not usable — same fallthrough.
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const waitMs = attempt > 0 ? DUMP_RETRY_BACKOFF_MS : 0;
    // Withhold the delete run's reserve, and count the backoff BEFORE spending
    // it: sleeping first and checking after would let the wait itself come out
    // of the reserve, which is the one thing the reserve exists to stop.
    if (deadline - Date.now() - waitMs - DELETE_RUN_RESERVE_MS < MIN_USEFUL_DUMP_MS) {
      return undefined;
    }
    if (waitMs > 0) await sleep(waitMs);
    const xml = await dumpAndroidUiXml(serial, {
      timeoutMs: clearLegTimeout(deadline, DELETE_RUN_RESERVE_MS),
    });
    // adb exits 0 even when the dump did not happen — a refused screen reports
    // an in-band `ERROR:` line, a lost race reports `Killed`. Neither carries a
    // hierarchy, which is the one test that covers both.
    if (xml.includes("<hierarchy")) return xml;
  }
  return undefined;
}

/**
 * Characters in the focused editable field, or undefined when it cannot be read
 * — in which case {@link clearByDeleting} uses BLIND_DELETE_COUNT.
 *
 * Undefined is returned when the dump fails or the device refuses it (locked
 * screen, secure overlay) or when no focused node is an `EditText`. A focused
 * password field is not measured either, but it does not make the whole result
 * undefined — it contributes BLIND_DELETE_COUNT, see below.
 *
 * Password fields are skipped because what uiautomator reports for them is not
 * the value: on API 36 it is the masked rendering (a 35-character password dumps
 * as 35 bullets), and on other levels it can be empty. The bullet count happens
 * to match the length there, but nothing guarantees a 1:1 mask, so it is treated
 * as unreadable rather than trusted.
 *
 * Restricting the measurement to `EditText` nodes is what makes a measured `0`
 * trustworthy. A dump can carry several `focused="true"` nodes — uiautomator
 * captures every window, so the IME or a systemui overlay contributes its own
 * focus — and a focused non-text container reports `text=""`. Taking the first
 * focused node in document order would read that as "the field is empty" and
 * issue only DELETE_MARGIN backspaces against a field that is not, leaving a
 * partly-cleared value reported as `cleared: true`. Where more than one editable
 * node claims focus, the longest wins: for the delete run over-deleting is a
 * no-op while under-deleting is the truncation this exists to avoid. The
 * MAX_DELETE_COUNT gate makes that asymmetry less clean than it reads — a long
 * field focused in ANOTHER window refuses the clear of a short one, and the
 * refusal quotes a length the target does not hold — so the message says the
 * count came from a focused field on screen rather than from "the" field.
 *
 * The XML goes through the describe stack's `parseUiAutomatorXml` rather than a
 * local regex. That parser already handles what a hand-rolled one gets wrong on
 * real dumps: a raw `>` inside a quoted attribute value (legal per XML §2.4, and
 * it does occur — a field holding `a > b` defeats a `[^>]*` tag matcher), and
 * the full entity set including numeric character references. `utils/` →
 * `tools/describe/` is an established direction here (utils/match-element-frame,
 * utils/ui-tree-match), and `blueprints/android-tv-control` already pairs this
 * module with that parser for the same focused-node purpose.
 */
async function measureFocusedTextLength(
  serial: string,
  deadline: number,
  preferredRead?: () => Promise<string | undefined>
): Promise<number | undefined> {
  let xml: string | undefined;
  try {
    xml = await readHierarchy(serial, deadline, preferredRead);
  } catch {
    return undefined;
  }
  if (xml === undefined) return undefined;
  const root = parseUiAutomatorXml(xml);
  if (!root) return undefined;

  let longest: number | undefined;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...node.children);
    const attrs = node.attrs;
    if (!attrIsTrue(attrs, "focused")) continue;
    // Same `EditText` test the TV focus walk uses for `isEditable`, so the two
    // agree on what counts as a text field.
    if (!/EditText/.test(attrs.class ?? "")) continue;
    // An unmeasurable focused editable — a password field, or one with no `text`
    // attribute — contributes the BLIND count rather than nothing.
    //
    // Both weaker rules are wrong, in opposite directions. Returning undefined
    // on sight abandons a length already found, so a dump carrying a measurable
    // 300-character field alongside an unreadable one falls to the blind run and
    // truncates the first. Merely skipping it is worse: a focused password field
    // beside a short focused sibling (`text="ab"`) would measure 2, issuing ten
    // backspaces where the field alone would have got the blind count. Flooring
    // keeps `longest` monotonic, which is what makes the "over-deleting is a
    // no-op, under-deleting truncates" rule above actually hold.
    const text = attrIsTrue(attrs, "password") ? undefined : attrs.text;
    longest = Math.max(longest ?? 0, text === undefined ? BLIND_DELETE_COUNT : [...text].length);
  }
  return longest;
}

/**
 * Resolve a named key (keyboard tool `key` vocabulary) to its
 * android.view.KeyEvent keycode, or throw. Split out from the injection so a
 * caller can validate a key name without pressing it — the keyboard backend does
 * that before a `clear`, which must not empty a field for a request it then
 * rejects.
 *
 * The iOS and Chromium backends resolve their own named key up front for the
 * same reason (`simulator-server-keys.ts`, `platforms/chromium.ts`); they need no
 * split helper because their key tables are plain lookups. Vega has neither the
 * split nor the hazard — `injectVegaNamedKey` resolves and presses in one
 * function, and `platforms/vega.ts` refuses `clear` outright.
 */
export function resolveAndroidNamedKeycode(name: string): number {
  const lower = name.toLowerCase();
  // Own-property check: `key` is a free string, so a prototype key like
  // "constructor" would otherwise pass the nullish guard with a garbage value
  // (Object.prototype.constructor) and shell out a broken keyevent instead of
  // rejecting as an unknown key.
  const keycode = Object.hasOwn(ANDROID_NAMED_KEYCODES, lower)
    ? ANDROID_NAMED_KEYCODES[lower]
    : undefined;
  if (keycode == null) {
    // Unknown key name is a caller input error (HTTP 400), not a 500. Carry the
    // same KEYBOARD_KEY_UNSUPPORTED telemetry code the iOS/chromium/vega backends
    // use (#420), so "unknown named key" buckets uniformly across platforms.
    throw new InvalidToolInputError(
      `Unknown key "${name}". Supported: ${Object.keys(ANDROID_NAMED_KEYCODES).join(", ")}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "keyboard_named_key_android",
        error_kind: "unsupported",
      }
    );
  }
  return keycode;
}

/** Press a named key (keyboard tool `key` vocabulary) on Android. */
export async function injectAndroidNamedKey(serial: string, name: string): Promise<void> {
  await injectAndroidKeycode(serial, resolveAndroidNamedKeycode(name));
}
