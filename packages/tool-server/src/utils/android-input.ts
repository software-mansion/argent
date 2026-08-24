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
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
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

// Keycodes used by the clear (select-all, then delete — or, when the caller's
// own text is what replaces the selection, no delete at all; see
// AndroidClearOptions.keepSelection).
const KEYCODE_CTRL_LEFT = 113;
const KEYCODE_A = 29;
const KEYCODE_DEL = 67;

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
 * measured (~7.3s — see there), with headroom.
 */
const DELETE_RUN_RESERVE_MS = 11_000;

/**
 * Wall-clock budget for one whole clear, shared across every adb round trip it
 * makes.
 *
 * A clear is up to four sequential adb calls plus, on the legacy path only, an
 * in-process backoff. Modern: the `keycombination` probe, the DEL, one dump to
 * read the field back, and the delete run that dump can call for. Legacy: the
 * probe, a `uiautomator dump`, a DUMP_RETRY_BACKOFF_MS wait, a second dump (see
 * {@link readHierarchy}) and the delete run. The two never compose — a rescue
 * carries its measurement down, so it does not dump again. One `text` OR `key`
 * injection still follows it inside the same request — the tool rejects both
 * together — under its own ADB_INPUT_TIMEOUT_MS cap. And the whole injected
 * clear is itself the SECOND tier: the accessibility replace runs first, under
 * its own ATOMIC_CLEAR_BUDGET_MS (8s) plus a 5s `ping` and a 15s `setText`. So
 * an Android `{ clear, text }` worst case sums to 8 + 5 + 15 + 26 + 15 = 69s,
 * well past the argent-mcp adapter's 30s per-request fetch timeout
 * (`FETCH_TIMEOUT_MS`, mcp-server.ts) — which is why `keyboard` declares
 * `longRunning` and the adapter does not apply that timeout to it. The clear's
 * own legs still share ONE deadline rather than being sized individually: the
 * budget below is what actually has to hold on the device, whatever the client
 * is willing to wait for.
 *
 * Sized as the support probe's share PLUS the delete run's reserve, rather than
 * as a round number. The probe is one ordinary `input` invocation, so starving
 * it below ADB_INPUT_TIMEOUT_MS — the cap every other `input` call in this file
 * gets — made `{ clear: true }` fail on a device where `{ text: "…" }` succeeds:
 * at a flat 20s budget the probe's own cap was 9s, and a loaded API 30 emulator
 * SIGKILLed it there. Deriving the budget from the two constants keeps the
 * probe's share equal to the ordinary one and the reserve intact, and leaves the
 * read legs whatever the probe does not spend — in the ordinary case (a warm
 * ~1s probe) about 14s, which is what makes {@link readHierarchy}'s two dumps
 * plus its backoff actually fit.
 *
 * It bounds the CLEAR only: `text` and `key` keep their own ADB_INPUT_TIMEOUT_MS
 * caps, which is the pre-existing budget for a call without a clear. So this
 * stops the clear from blowing the request budget on its own; it does not turn
 * the whole tool call into one deadline, which would mean threading it through
 * the text/key injectors the Android-TV blueprint shares.
 */
const ANDROID_CLEAR_BUDGET_MS = ADB_INPUT_TIMEOUT_MS + DELETE_RUN_RESERVE_MS;

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

interface AndroidClearOptions {
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
   * Measured end to end on that emulator, 6/6 — a 200-character field kept its
   * head with the new text appended to it, and the MAX_DELETE_COUNT refusal
   * that would otherwise have caught it never fired.
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
  /**
   * Text follows in the same request, so leave the field's contents SELECTED
   * instead of deleting them: the first character typed replaces the selection,
   * and the field never passes through an empty state at all.
   *
   * SECOND CHOICE, and only reached when the devtools helper cannot do the job.
   * A `{ clear, … }` is served first by one atomic accessibility edit
   * (`AndroidDevtoolsApi.setText`, see `tryAtomicClear` in the keyboard
   * backend), which needs no select-all chord and is verified by reading the
   * field back. This option is what the injected path does when that is
   * unavailable — no helper running, a helper too old to know the method, or a
   * widget that refused. It closes the SAME race, so the corruption below cannot
   * come back on that path; what it cannot do is notice a select-all the app
   * ignored. Measured: a Flutter `TextField` swallows the Ctrl+A chord silently,
   * so this path leaves the old value whole and splices the text in at the caret
   * while still reporting `cleared: true` — which is why the keyboard backend
   * attaches a `note` whenever the atomic path was not the one that ran.
   *
   * This is the fix for a race that made `{ clear, text }` corrupt the value it
   * was replacing, reproduced on a Pixel 3a (API 36) against Bluesky's search
   * box: 4/10 and 3/14 direct calls, and 5 of 12 runs of a saved flow built on
   * them. Every failure was a proper SUFFIX of the requested text — `Friends`
   * came back as `riends`, `iends`, `ends`, `ds`, and twice as nothing at all —
   * which is the shape of an edit that emptied the field again PART WAY THROUGH
   * the typing, destroying the characters already sent.
   *
   * The empty field is what provokes it, and the app's reaction is asynchronous:
   * it lands a few hundred milliseconds after the delete, by which time the next
   * `adb shell input` has started typing. Three measurements place the blame
   * there. Typing the same string with no clear at all — over the selection the
   * app itself makes on focus — never corrupted (8/8), so the typing is not what
   * breaks. Removing only the delete, so the text replaces the selection, never
   * corrupted (3 runs of 10). And leaving the delete in but pausing 300ms before
   * typing never corrupted either (10/10) — the reaction had already landed.
   * It also takes a real focus change first (a tap that re-focuses an already
   * focused field reproduced nothing in 10 runs), which is what puts the app's
   * JS thread far enough behind for the reaction to land mid-typing.
   *
   * So the window cannot be timed out of: the delete and the text are separate
   * `input` invocations, the gap between them is one process spawn on the device
   * (~300ms), and the reaction latency moves with the JS thread's load — which
   * is why the fix removes the trigger rather than waiting for it. The app is
   * handed `F`, never `""`.
   *
   * Only the `keycombination` path can honour this — {@link clearByDeleting}
   * has no selection primitive to leave behind (that is the whole reason it
   * backspaces), so on those levels the empty state, and the race with it,
   * remain. {@link AndroidClearOutcome.keptSelection} is what actually happened;
   * this is only what was asked for.
   */
  keepSelection?: boolean;
  /**
   * An accessibility replace was ACCEPTED by the widget before this ran, so the
   * field may already hold the value the caller asked for.
   *
   * Only the over-length refusal reads it, and only to stop saying "Nothing was
   * modified" — a sentence that makes a retry against the original value look
   * safe. The caller sets it from the helper's own `applied` flag, never from
   * the reason's NAME: the two coincide for every reply this build knows
   * (`unverifiable` and `value_mismatch` are the pair the helper sets it on),
   * but a reply carrying `applied: true` with no reason, or a reason from a
   * newer helper, would answer "nothing was written" under a name-keyed rule —
   * the one answer that must not be guessed. See `DOUBLED` in
   * `keyboard/android-clear-note.ts`, which is decided the same way.
   */
  atomicWriteApplied?: boolean;
  /**
   * The value the caller is about to type came from a `{{secret:…}}`
   * placeholder, so the over-length refusal must not quote the field's exact
   * character count.
   *
   * The box a credential is typed into is usually the box that already holds
   * one, and the count here is that field's length — reachable with
   * `{ clear: true, text: "{{secret:X}}" }` against a plain (non-`password`) box
   * holding a long token. `redactSecretsFromError` substitutes the resolved
   * value string and cannot redact a number. Same rule, and the same reasoning,
   * as the chromium backend's two messages.
   */
  secretText?: boolean;
}

/**
 * Which of the injected clears actually ran, so the keyboard backend can say so
 * in its `note` rather than inferring it from the request.
 *
 * Inference does not work here: every one of these is chosen from something the
 * DEVICE said (the probe's output, the field read back afterwards), not from
 * anything the caller asked for. `keepSelection` in particular is a request the
 * legacy path cannot honour.
 *
 * - `select-all` — the chord, then DEL. The field read back empty, or the
 *   read-back proved nothing — {@link AndroidClearOutcome.readBackEmpty} is what
 *   tells those apart, because only the first of them confirms the clear.
 * - `select-all-kept` — the chord alone, with the caller's own text left to
 *   replace the selection. Nothing verified it, and nothing can: the field is
 *   SUPPOSED to still hold its value at that point.
 * - `select-all-rescued` — the field still reported a value the read-back could
 *   tell apart from its placeholder, and a delete run removed it. Evidence the
 *   chord left something behind, not proof that it failed: the reading covers
 *   every window, so it can belong to another focused field.
 * - `delete-run` — this level has no `input keycombination` at all.
 */
type AndroidClearPath = "select-all" | "select-all-kept" | "select-all-rescued" | "delete-run";

export interface AndroidClearOutcome {
  path: AndroidClearPath;
  /**
   * A selection was left standing for the caller's text to replace.
   *
   * NOT the same as {@link AndroidClearOptions.keepSelection} having been asked
   * for: the legacy fallback has no selection primitive, so it empties the field
   * however the option was set. A caller that reports the field's state on a
   * later failure has to read it from here rather than from its own request.
   */
  keptSelection: boolean;
  /**
   * A delete run ran without a length to size it, so it sent the fixed
   * BLIND_DELETE_COUNT — see there for the field it still truncates. Absent on
   * every path that sent no delete run, and on every run that WAS sized.
   *
   * Typed `true` rather than `boolean` so "absent" is the only way to say no: a
   * `false` here would read as "a sized run happened", which is a different
   * claim from "no run happened at all", and both spell the same word.
   */
  blindDeleteRun?: true;
  /**
   * The field was read back after the delete and reported NO text.
   *
   * Only `select-all` carries it, and only for one of the four read-backs that
   * reach that path. The other three are a screen the reader could not capture
   * at all, a focused field it could not measure (a password box is floored to
   * the blind count rather than dropped — see `measureFocusedTextLength`), and a
   * positive reading from a source that cannot separate a value from a
   * placeholder. All three end the same way as an empty field and not one of
   * them confirms anything, so the caller's note has to tell them apart.
   *
   * Typed `true` rather than `boolean` for the reason `blindDeleteRun` is: the
   * paths that read nothing back must carry nothing, not a `false` that reads as
   * "read back, and not empty".
   */
  readBackEmpty?: true;
}

/**
 * Empty the focused text field: select its whole contents, then delete.
 *
 * With {@link AndroidClearOptions.keepSelection} the delete is skipped and the
 * contents are left SELECTED for the caller's own text to replace — see that
 * option for why a `{ clear, text }` must not empty the field first.
 *
 * Ctrl+A is the Android select-all chord (it is what a hardware keyboard sends),
 * and `input keycombination` is the only `input` subcommand that can hold one
 * key while pressing another. On a native `EditText` (Settings search) it is
 * exact — 104 runs, no miss. On a React Native `TextInput` it is not, which is
 * why the result is read back rather than trusted; see the verify leg below.
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
 * A throw from the PROBE is left to propagate as the genuine transport failure
 * it is: nothing has been sent to the field at that point. The delete that
 * follows it is different — the select-all has landed by then — so that leg is
 * rewrapped, the same way the legacy path rewraps its delete run.
 *
 * On a level without `keycombination` the clear falls back to
 * {@link clearByDeleting}.
 */
export async function injectAndroidClear(
  serial: string,
  options: AndroidClearOptions = {}
): Promise<AndroidClearOutcome> {
  // One deadline for every leg below — see ANDROID_CLEAR_BUDGET_MS.
  const deadline = Date.now() + ANDROID_CLEAR_BUDGET_MS;
  const out = await adbShell(
    serial,
    `input keycombination ${KEYCODE_CTRL_LEFT} ${KEYCODE_A} 2>&1`,
    { timeoutMs: clearLegTimeout(deadline, DELETE_RUN_RESERVE_MS) }
  );
  if (/unknown command|usage: input/i.test(out)) {
    // `keepSelection` is unhonourable here — the fallback backspaces, so the
    // field ends up EMPTY whatever was asked for.
    const blind = await clearByDeleting(serial, deadline, options);
    return { path: "delete-run", keptSelection: false, ...blind };
  }
  // Text follows, so the select-all IS the clear: the caller's first character
  // replaces the selection in one edit, and the app never sees the empty field
  // it would otherwise react to. See AndroidClearOptions.keepSelection for the
  // race this removes and why no delay closes it.
  //
  // Nothing verifies this one, and the read-back below could not: the field is
  // supposed to still hold its whole value here, so a residue is the expected
  // state rather than the failure signal it is after a DEL.
  if (options.keepSelection) return { path: "select-all-kept", keptSelection: true };
  // Capped at the ordinary per-`input` budget as well as at the shared deadline.
  // `clearLegTimeout(deadline)` alone handed this leg everything the probe did
  // not spend — ~25s after a warm probe, 10s past the cap every other `input`
  // call in this file gets, and the reserve is what guarantees its floor anyway.
  // One `keyevent` has no reason to outlive ADB_INPUT_TIMEOUT_MS.
  try {
    await adbShell(serial, `input keyevent ${KEYCODE_DEL}`, {
      timeoutMs: Math.min(ADB_INPUT_TIMEOUT_MS, clearLegTimeout(deadline)),
    });
  } catch (cause) {
    // The select-all has already been applied, and it SURVIVES the killed delete
    // — verified on API 36: after this leg was SIGKILLed the field still held its
    // whole value, and the next character typed into it replaced the lot. So the
    // field is in one of two states and the caller cannot tell which, which is
    // the same report the legacy path's delete run gives. `adbShell`'s own error
    // is filed under ANDROID_ADB_COMMAND_FAILED and says only that
    // `input keyevent 67` was killed, so a caller reads a transport fault and
    // retries against a field it believes is untouched.
    throw new FailureError(
      `keyboard clear: the delete did not finish on this device, so the focused field is ` +
        `either empty or still holds its whole value with all of it SELECTED — the select-all ` +
        `landed and survives, so the next character typed into it replaces the value. Nothing ` +
        `was typed. Read the field's actual contents before continuing; do not treat it as ` +
        `unchanged, and do not send a replacement that assumes it is empty.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED,
        failure_stage: "keyboard_clear_delete_android",
        failure_area: "tool_server",
        error_kind: getFailureSignal(cause)?.error_kind ?? "subprocess",
      }
    );
  }
  // The chord lands; the SELECTION does not always follow it. Against a React
  // Native `TextInput` 15 of 85 clears over this path left the field short by
  // exactly the character the DEL took, every one of them returning
  // `cleared: true` over a value the `text` then appended to (Expo dev-launcher
  // URL field, Pixel 6 / API 34; the same 85 against a native `EditText` and the
  // fixed path both ran clean). `input` exits 0 either way — the same silent
  // no-op as the missing subcommand above, so the probe cannot catch it.
  //
  // Holding the chord longer is not the fix: `-t 100` still missed 2/30 and
  // `-t 300` 7/30, worse rather than better. Reading the field back is, and a
  // residue goes to the delete run, which needs no selection to be correct.
  //
  // Short fields are the ones that fail: 11 of 80 at 6 characters, 0 of 80 at
  // 160 and 200 (settling time is not the variable — a 4s pause before the chord
  // left the 6-character rate unchanged). So a residue reaching the delete run
  // has always been far inside MAX_DELETE_COUNT, and its length refusal below is
  // a guard, not a limit this path has been seen to hit.
  //
  // Only a POSITIVE, SIZED reading redirects. Unreadable is evidence of nothing,
  // and treating it as failure would spend a blind BLIND_DELETE_COUNT run on
  // every clear taken where `measureFocusedTextLength` cannot see.
  //
  // `sized` is load-bearing, not belt-and-braces. An unmeasurable focused
  // editable — a password field is the reachable shape — is not absent from the
  // measurement: it is FLOORED to BLIND_DELETE_COUNT (see
  // measureFocusedTextLength), so a bare `chars > 0` reads 150 as a residue and
  // rescues every single clear on such a field, whether or not the chord took.
  // That is the opposite of "only a positive reading redirects".
  //
  // A reading that could be the field's own PLACEHOLDER does not redirect
  // either, which is what `hintKnown` gates. An emptied field reports its
  // placeholder in the same `text` attribute as a real value, so a search box or
  // a login field measures a residue it does not hold; only a source that names
  // the placeholder as well can tell those apart, and not every one does (see
  // FocusedTextMeasurement.hintKnown).
  //
  // Erring the other way — sending the run on a reading that might be a
  // placeholder — is not free, which is why an unprovable reading is treated as
  // no reading. The backspaces are not absorbed by the empty field:
  // `BaseKeyListener` leaves `KEYCODE_DEL` unconsumed when there is nothing to
  // delete, so each one reaches the APP, and a widget that reads
  // backspace-on-empty as "remove the item before the caret" — a chip or
  // recipient field, a segmented OTP box, a React Native `TextInput` with an
  // `onKeyPress` handler — is emptied by a clear that then reports
  // `cleared: true`. Measured on API 36 against a chip field a `{ clear: true }`
  // sent 13 of them and took every chip with it. A clear that cannot be
  // confirmed is reported as unconfirmed instead; see `androidClearNote`.
  const residue = await measureFocusedTextLength(serial, deadline, options.readHierarchy, 1);
  if (residue?.sized === true && residue.hintKnown && residue.chars > 0) {
    const blind = await clearByDeleting(serial, deadline, options, residue.chars);
    return { path: "select-all-rescued", keptSelection: false, ...blind };
  }
  // A SIZED zero is the only reading that says the field is empty. Three others
  // arrive here and not one of them confirms anything: a screen that would not
  // capture, a field that cannot be measured, and a positive reading that could
  // be the placeholder — see AndroidClearOutcome.readBackEmpty.
  return {
    path: "select-all",
    keptSelection: false,
    ...(residue?.sized === true && residue.chars === 0 ? { readBackEmpty: true as const } : {}),
  };
}

const KEYCODE_MOVE_END = 123;

// Extra backspaces beyond the field's measured length. The measurement and the
// delete run are two separate device round trips reading two different sources
// of truth — uiautomator's cached view text versus the editor's live buffer —
// so a small overshoot absorbs any skew between them (an in-flight IME
// composition, a field whose displayed text is shorter than its value).
// Backspace on an empty field is a no-op, so overshooting costs only key events.
const DELETE_MARGIN = 8;

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

// Used when the focused field's contents cannot be measured: no focused
// *editable* node in the dump, a password field (whose reported text is the
// mask, not the value), or a dump that failed outright. Covers any credential or
// single-line form field.
//
// This IS the fixed run the measurement exists to avoid, so it carries that
// shape's failure with it: a field longer than this PLUS DELETE_MARGIN — the
// count actually sent — keeps its head. Which is why it is the LIMIT rather than
// a smaller number of its own: at 120 the blind run left a 140-character field
// holding its first 12 characters with the new text appended to them, and
// returned 200 `{"cleared": true}` (reproduced 2/3 on API 30 against three
// competing `uiautomator dump` loops). Every length below is a field this path
// accepts when it CAN measure it, so a blind run that stops short corrupts a
// field the tool otherwise supports. Tied to the limit so the blind run always
// covers the whole accepted range: past it the clear is refused whenever the
// length is readable, and only an unreadable over-long field is still truncated
// — the residue the tool's own description warns about.
//
// It MUST NOT exceed MAX_DELETE_COUNT. An unmeasurable focused editable floors
// the measurement to this value rather than vanishing from it (see
// measureFocusedTextLength), so the blind count is what the length refusal
// compares — and if it sat above the limit, every unmeasurable field (every
// password field on these levels) would be refused, quoting this constant as
// though it were a length that had been measured. The refusal is `count >
// MAX_DELETE_COUNT`, so equality is allowed and `<=` is the relationship.
// The relationship is pinned by the delete-run assertions in
// test/keyboard-clear.test.ts, which expect `MAX_DELETE_COUNT + DELETE_MARGIN`
// keys on the unmeasurable paths (a password field, a dump that failed) —
// nothing else would catch the two being separated again.
// Not exported: it IS MAX_DELETE_COUNT, so a second exported name for the same
// value is a duplicate export. The name stays because the two roles are
// different — one is the longest field this path accepts, the other is how far
// it deletes when it cannot measure — and the whole point of the fix is that
// they have to be the same number.
const BLIND_DELETE_COUNT = MAX_DELETE_COUNT;

/**
 * Empty the focused field without a selection: move the caret to the end of the
 * line, then backspace over the contents.
 *
 * Two callers. A level whose `input` has no `keycombination` has no other clear
 * available, and reaches this having sent nothing. The select-all path reaches
 * it with `rescueFrom` set, having already measured the residue its chord failed
 * to remove — so this must not dump a second time, and the over-length refusal
 * below must not tell that caller the field is untouched.
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
 * Note an EMPTY field publishes its hint in the same `text` attribute as a real
 * value, so a measurement can be the placeholder rather than content.
 * {@link measureFocusedTextLength} reads the `hint` out and answers 0 wherever
 * the source names it — API 36's dump does, API 30's carries no `hint` at all,
 * and neither does the helper's `captureXml`. Where it is not named the
 * over-measurement stands, and for the delete run it is close to harmless: the
 * run is a little longer than it needs to be, and this path is the only clear
 * the level has, so its backspaces are what the caller asked for either way. It
 * is NOT harmless for the MAX_DELETE_COUNT gate below, which turns any
 * over-measurement into a refusal: an empty field whose placeholder is longer
 * than the limit is refused with a length it does not hold. Accepted rather than
 * fixed, because the alternative (delete first, judge after) can only discover a
 * real over-long field by having already truncated it. A placeholder that long is
 * also not a shape these single-line fields take.
 *
 * Known limit, and the reason the select-all is tried first rather than this:
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
  options: AndroidClearOptions,
  rescueFrom?: number
): Promise<{ blindDeleteRun?: true }> {
  // Kept as its own binding rather than folded into the `??` chain: the caller's
  // note has to say whether this run was SIZED or blind, and `count` alone
  // cannot answer that — an unmeasurable focused editable is floored to
  // BLIND_DELETE_COUNT by the measurement itself (see there), so the number is
  // the same either way.
  // A rescue arrives with the residue its caller already measured off the field,
  // and its caller only redirects on a SIZED reading (see injectAndroidClear), so
  // this is sized by construction rather than by assumption; only the legacy path
  // has to ask.
  const measured: FocusedTextMeasurement | undefined =
    rescueFrom === undefined
      ? await measureFocusedTextLength(serial, deadline, options.readHierarchy)
      : { chars: rescueFrom, sized: true, hintKnown: true };
  const count = measured?.chars ?? BLIND_DELETE_COUNT;
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
    // The count is the FIELD's length, and a request carrying a `{{secret:…}}`
    // is usually aimed at the box that already holds one — so quoting it there
    // puts a credential's exact length in the agent's context, transcript and
    // logs. See AndroidClearOptions.secretText.
    const reports = options.secretText
      ? `reports more characters than`
      : `reports ${count} characters, more than`;
    // Why backspaces are the only clear left, and what the field is holding now,
    // both differ by caller: the legacy path is chosen because the level has no
    // `keycombination` and refuses before sending anything, while the rescue is
    // reached after a select-all and a DEL have already gone out.
    //
    // The rescue arm states no more than that. The count comes from the same
    // whole-screen measurement the sentence below warns about, so it does not
    // prove the chord failed on the field the caller meant: the reading can be
    // ANOTHER window's focused field, or this field's own placeholder. Naming
    // the two possible states is what a caller can act on; asserting one of them
    // is how a message ends up describing a clear that fully worked.
    const why =
      rescueFrom === undefined
        ? `Without \`input keycombination\` (added after API 30) the only available clear is ` +
          `one backspace per character, which is too slow to finish reliably past ` +
          `${MAX_DELETE_COUNT}.`
        : `A select-all and a delete were already sent, and a focused field still reports this ` +
          `much, so one backspace per character is the only clear left — too slow to finish ` +
          `reliably past ${MAX_DELETE_COUNT}.`;
    // "Nothing was modified" is only true when nothing reached the field at all.
    // The legacy arm can be entered after an accessibility replace the widget
    // ACCEPTED — nothing ties the helper's protocol to the API level, so a
    // protocol-2 helper on a level without `keycombination` is an ordinary
    // configuration — and there the sentence is what makes a retry against the
    // original value look safe.
    const prior = options.atomicWriteApplied
      ? ` An accessibility replace was ACCEPTED by the widget before this ran, so the field may ` +
        `already hold the value you asked for.`
      : ``;
    const state =
      rescueFrom === undefined
        ? options.atomicWriteApplied
          ? `Nothing was typed.${prior}`
          : `Nothing was modified and nothing was typed.`
        : `The field HAS been touched: if the select-all took, the delete emptied it; if it did ` +
          `not, the delete removed one character. Nothing was typed.${prior}`;
    const remedy =
      rescueFrom === undefined
        ? `Clear the field with the app's own affordance, or use an emulator on a newer API ` +
          `level.`
        : `Read the field's actual contents, then clear it with the app's own affordance.`;
    throw new InvalidToolInputError(
      `keyboard clear: a focused text field on this screen ${reports} ` +
        `this Android level can clear. ${why} The count comes from the screen's view ` +
        `hierarchy, which reports an empty field's placeholder in the same attribute as its ` +
        `value and covers every window, so it may belong to a different focused field than ` +
        `the one you meant. ${state} ${remedy}`,
      {
        // Its own code rather than KEYBOARD_CLEAR_INEFFECTIVE: both callers reach
        // this with the same caller-fixable condition (a 400) — the field is
        // longer than backspaces can clear, and the remedy is the app's own
        // affordance — whereas INEFFECTIVE is raised after the edit was attempted
        // and observed not to take, a page-side cancellation of the key or the
        // `beforeinput`, which is a 500 because the caller cannot fix it, not
        // because anything inside the tool went wrong. Sharing one code would
        // mix "this field cannot be cleared this way" with "the edit was refused
        // by the app" in any dashboard slicing on it. What differs between the
        // two callers is only whether anything was sent first, and that is
        // carried by the message rather than by a second code.
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_FIELD_TOO_LONG,
        failure_stage: "keyboard_clear_too_long_android",
        error_kind: "unsupported",
      }
    );
  }
  const dels = Array.from({ length: keys }, () => KEYCODE_DEL).join(" ");
  // One invocation for the whole run: `input keyevent` accepts a keycode list.
  // No reserve withheld — this IS the leg the reserve was held for, so it gets
  // everything remaining.
  try {
    await adbShell(serial, `input keyevent ${KEYCODE_MOVE_END} ${dels}`, {
      timeoutMs: clearLegTimeout(deadline),
    });
  } catch (cause) {
    // A run that does not come back leaves the field in a state no caller can
    // guess: killing adb part-way does NOT stop the device (measured on API 36,
    // deletes already handed over keep landing), and the reserve above is what
    // keeps this from being the normal outcome — but a loaded emulator still
    // reaches it, and it did, leaving a 113-character field holding 3.
    //
    // Rewrapped rather than propagated because `adbShell`'s own error is the
    // wrong report for that: it is filed under ANDROID_ADB_COMMAND_FAILED, its
    // message is the argv — here a ~700-character dump of `input keyevent 123
    // 67 67 67 …` — and nothing in it says the field was modified at all, so a
    // caller reads a transport fault and retries against a field it believes is
    // untouched. The cause is deliberately not quoted: it carries no
    // information this message does not, and all of its length.
    // `keys` is the field's measured length plus the public DELETE_MARGIN, so on
    // a `{{secret:…}}` request it publishes a credential's exact length — the
    // same number, for the same reason, that the over-length refusal above
    // withholds. `redactSecretsFromError` substitutes the value string and cannot
    // redact a count. Withheld whenever `secretText` is set, matching that
    // sibling rather than reasoning separately about a blind count.
    const sent = options.secretText
      ? `as many backspaces as the field's length needed were sent`
      : `up to ${keys} backspaces were sent`;
    // "MAY be", not "is": the run is killed part-way on a timeout, but the same
    // catch also covers a cause that stopped it before anything went out at all
    // (the device went offline, adb lost authorisation), where the field is
    // untouched. The remedy is the same either way — read it, do not assume —
    // and asserting a state that did not happen is what the message must not do.
    throw new FailureError(
      `keyboard clear: the delete run did not finish on this device, so the focused field may ` +
        `be PARTLY emptied — ${sent} and an unknown number of them landed. ` +
        `Nothing was typed. Read the field's actual contents before continuing; do not treat ` +
        `it as unchanged, and do not send a replacement that assumes it is empty.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED,
        failure_stage: "keyboard_clear_delete_run_android",
        failure_area: "tool_server",
        error_kind: getFailureSignal(cause)?.error_kind ?? "subprocess",
      }
    );
  }
  // Only ever `true` or absent, never `false`: it spreads into
  // {@link AndroidClearOutcome}, where the field is optional precisely so the
  // paths that send no delete run at all carry nothing rather than a `false`
  // that reads as "a sized run happened".
  return measured?.sized === true ? {} : { blindDeleteRun: true };
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
 * A reply worth measuring: it carries the hierarchy tag AND at least one node.
 *
 * The tag alone is the right test for a DUMP, which announces a failed capture
 * in-band (`ERROR:` for a refused screen, `Killed` for a lost race, neither
 * carrying the tag). It is not enough for the {@link AndroidClearOptions.readHierarchy}
 * helper, whose `captureXml` writes the `<hierarchy rotation="…">` wrapper
 * unconditionally — including when the walk it wraps dropped the subtree holding
 * the focused `EditText`. An empty wrapper passed, both dump attempts were
 * skipped, and the clear silently became the blind delete count that truncates a
 * long field. (`platforms/android.ts` refuses the two cases it can see from the
 * typed result; this covers the reply that claims windows and still carries no
 * tree.)
 */
const hasNodes = (xml: string) => xml.includes("<hierarchy") && xml.includes("<node");

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
 * Returns undefined when no attempt produced a hierarchy, or when there is not
 * enough budget left to try.
 *
 * `maxDumps` is what the select-all's read-back turns down to 1. The retry is
 * paid for by the sizing read above — there, failing means the blind count and a
 * truncated field. The read-back has no such stake: an unreadable answer leaves
 * the fast path exactly as it was, so a second dump only adds
 * DUMP_RETRY_BACKOFF_MS to every clear on a screen that will not dump.
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
  preferredRead?: () => Promise<string | undefined>,
  maxDumps = 2
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
    // The loser of a race is abandoned, not cancelled, and an armed
    // `setTimeout` holds the event loop open on its own — so when
    // `preferredRead` wins, a bare `sleep()` here keeps a handle alive for the
    // rest of the budget. Harmless in the long-lived tool-server, but it delays
    // the exit of any short-lived process that imports this, so the timer is
    // cleared either way.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const xml = await Promise.race([
        preferredRead(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), preferredBudgetMs);
        }),
      ]);
      if (xml && hasNodes(xml)) return xml;
    } catch {
      // The helper is not usable — same fallthrough.
    } finally {
      clearTimeout(timer);
    }
  }
  for (let attempt = 0; attempt < maxDumps; attempt++) {
    const waitMs = attempt > 0 ? DUMP_RETRY_BACKOFF_MS : 0;
    // Withhold the delete run's reserve, and count the backoff BEFORE spending
    // it: sleeping first and checking after would let the wait itself come out
    // of the reserve, which is the one thing the reserve exists to stop.
    if (deadline - Date.now() - waitMs - DELETE_RUN_RESERVE_MS < MIN_USEFUL_DUMP_MS) {
      return undefined;
    }
    if (waitMs > 0) await sleep(waitMs);
    // A THROWN attempt has to fall through to the next one, not out of the
    // loop. `dumpAndroidUiXml` throws on any transport failure — a dropped
    // socket, an `adb` still attaching to a just-booted device — and those fail
    // FAST, so an unguarded throw skipped the backoff retry entirely and dropped
    // to the blind count with almost the whole budget unspent. The retry exists
    // precisely for a transient reader, and a transient reader is what this is.
    let xml: string;
    try {
      xml = await dumpAndroidUiXml(serial, {
        timeoutMs: clearLegTimeout(deadline, DELETE_RUN_RESERVE_MS),
      });
    } catch {
      continue;
    }
    // adb exits 0 even when the dump did not happen — a refused screen reports
    // an in-band `ERROR:` line, a lost race reports `Killed`. Neither carries a
    // hierarchy, which is the one test that covers both.
    if (hasNodes(xml)) return xml;
  }
  return undefined;
}

/**
 * How long the focused field is, and whether that number was actually READ off
 * it.
 *
 * The two cannot be collapsed into the number alone: an unmeasurable focused
 * editable is floored to BLIND_DELETE_COUNT (see below), which is also exactly
 * what a genuine 150-character field measures. The delete run does not care —
 * it sends the same keys either way — but the caller's `note` does, because an
 * unsized run is the one that silently truncates a longer field.
 */
interface FocusedTextMeasurement {
  chars: number;
  /** The count came from a field's readable `text`, not from the blind floor. */
  sized: boolean;
  /**
   * The source spelled the field's `hint` out as well, so a positive `chars` is
   * its VALUE rather than its placeholder.
   *
   * An empty field publishes its placeholder in the same `text` attribute as a
   * real value. A source that carries `hint` too tells the two apart — the field
   * is showing its placeholder exactly when the two read the same, and its value
   * is then empty. A source that does not carry it cannot: a positive count is
   * either.
   *
   * So this is a property of the READER as much as of the field. `uiautomator`
   * emits the attribute on API 36 (measured: an emptied box dumps `text="plain"
   * … hint="plain"`, and the same box holding a value dumps
   * `text="OriginalValue" … hint="plain"`), emits none of it on API 34, and the
   * devtools helper's `captureXml` does not emit it on any level.
   */
  hintKnown: boolean;
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
  preferredRead?: () => Promise<string | undefined>,
  maxDumps?: number
): Promise<FocusedTextMeasurement | undefined> {
  let xml: string | undefined;
  try {
    xml = await readHierarchy(serial, deadline, preferredRead, maxDumps);
  } catch {
    return undefined;
  }
  if (xml === undefined) return undefined;
  const root = parseUiAutomatorXml(xml);
  if (!root) return undefined;

  let longest: number | undefined;
  // Whether the winning number came from a field whose text could actually be
  // read. A floored one is BLIND_DELETE_COUNT, and so is a genuine 150-character
  // field, so the count alone cannot answer it — see FocusedTextMeasurement.
  let sized = false;
  // Whether the winning node's source could tell a value from a placeholder.
  // Only the winner's own answer counts: it is the count the caller acts on.
  let hintKnown = false;
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
    const shown = attrIsTrue(attrs, "password") ? undefined : attrs.text;
    // What the field DISPLAYS is not what it holds: an empty one displays its
    // placeholder here. Where the source names the placeholder too, the two
    // reading the same IS that state, and the value behind it is empty — see
    // FocusedTextMeasurement.hintKnown.
    const hint = attrs.hint;
    const text = shown !== undefined && shown === hint ? "" : shown;
    const chars = text === undefined ? BLIND_DELETE_COUNT : [...text].length;
    // `>` and not `>=`, so a tie keeps the EARLIER verdict rather than letting
    // whichever node the walk reached last decide it — except that an
    // unmeasurable field always wins a tie, below. The walk's order is an
    // implementation detail of the stack, and a report that flips with it is
    // worse than either answer.
    if (longest === undefined || chars > longest) {
      longest = chars;
      sized = text !== undefined;
      hintKnown = hint !== undefined;
    } else if (chars === longest && text === undefined) {
      // A tie against an unmeasurable field still means the run is not sized to
      // anything that was read: the same number arrived from a field nobody
      // could measure, so claiming it was measured would be a guess dressed up.
      sized = false;
    }
  }
  return longest === undefined ? undefined : { chars: longest, sized, hintKnown };
}

/**
 * Resolve a named key (keyboard tool `key` vocabulary) to its
 * android.view.KeyEvent keycode, or throw. Split out from the injection so a
 * caller can validate a key name without pressing it — the keyboard backend does
 * that before typing, and before a `clear`, which must not empty a field for a
 * request it then rejects.
 *
 * The iOS and Chromium backends resolve their own named key up front for the
 * same reason (`simulator-server-keys.ts`, `platforms/chromium.ts`); they need no
 * split helper because their key tables are plain lookups. Vega has no such
 * split and needs none: `platforms/vega.ts` refuses `clear` outright, so the
 * destructive hazard never reaches it, and the tool rejects `{ text, key }`
 * before the dispatch — leaving nothing there for an early resolve to protect.
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
