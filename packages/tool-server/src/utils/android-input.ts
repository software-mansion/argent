/**
 * Android key / text / button injection over `adb shell input`.
 *
 * The bundled simulator-server injects keys as USB-HID events, which the guest
 * silently drops on AVDs created with `hw.keyboard = no`; because that transport
 * is fire-and-forget, the `keyboard` and `button` tools reported success while
 * injecting nothing (https://github.com/software-mansion/argent/issues/449).
 * `adb shell input` goes through Android's InputManager, so it lands regardless
 * of `hw.keyboard`, and a non-zero exit surfaces as a thrown error. Touch
 * injection stays on the simulator-server.
 */
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import { adbShell, shellQuote } from "./adb";
import { InvalidToolInputError } from "./capability";
import { CLEAR_KEY_PAIRS } from "../tools/keyboard/key-codes";

// android.view.KeyEvent keycodes; must cover every key in
// ../tools/keyboard/key-codes.ts NAMED_KEYS.
export const ANDROID_NAMED_KEYCODES: Record<string, number> = {
  "enter": 66, // KEYCODE_ENTER
  "return": 66, // alias of enter
  "escape": 111, // KEYCODE_ESCAPE
  "esc": 111, // alias of escape
  "backspace": 67, // KEYCODE_DEL
  // KEYCODE_DEL, not KEYCODE_FORWARD_DEL (112): the shared HID vocabulary in
  // key-codes.ts maps both `backspace` and `delete` to usage 42, and a named key
  // must mean the same thing on every platform.
  "delete": 67,
  "tab": 61, // KEYCODE_TAB
  "space": 62, // KEYCODE_SPACE
  "arrow-up": 19, // KEYCODE_DPAD_UP
  "arrow-down": 20, // KEYCODE_DPAD_DOWN
  "arrow-left": 21, // KEYCODE_DPAD_LEFT
  "arrow-right": 22, // KEYCODE_DPAD_RIGHT
  // KEYCODE_F1 (131) .. KEYCODE_F12 (142) are contiguous.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 131 + i])),
};

// android.view.KeyEvent keycodes; must cover BUTTONS_BY_PLATFORM.android in
// ../tools/button/index.ts.
export const ANDROID_BUTTON_KEYCODES: Record<string, number> = {
  home: 3, // KEYCODE_HOME
  back: 4, // KEYCODE_BACK
  power: 26, // KEYCODE_POWER
  volumeUp: 24, // KEYCODE_VOLUME_UP
  volumeDown: 25, // KEYCODE_VOLUME_DOWN
  appSwitch: 187, // KEYCODE_APP_SWITCH
};

// `input text` reliably types only printable ASCII: a newline can't be
// represented, emoji crash `InputShellCommand.sendText` with a NullPointerException,
// and other non-ASCII (accented letters, CJK) is silently dropped by the virtual
// KeyCharacterMap. Reject it up front naming the character, instead of a cryptic
// crash or a silently-wrong field. (`%` is typeable but needs escaping — see
// `splitForVerbatimPercent`.)
export function assertTypeableAndroidText(text: string): void {
  // Own message: the one non-typeable character with an obvious alternative.
  if (/[\n\r]/.test(text)) {
    // InvalidToolInputError maps to HTTP 400; the granular code keeps this in the
    // same KEYBOARD_CHARACTER_UNSUPPORTED bucket as the iOS/chromium backends (#420).
    throw new InvalidToolInputError(
      // The advice must also hold on the TV path (typeTv), which rejects named
      // keys in favour of tv-remote select.
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
      // Same KEYBOARD_CHARACTER_UNSUPPORTED bucket as the iOS/chromium backends (#420).
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

// `InputShellCommand.sendText` rewrites `%s` into a single space (and does not
// unescape `%%`), so one `input text "100%safe"` types `100 afe`. With every `%`
// last in its segment and one `input text` per segment, no `%` is ever followed
// by `s`, and the segments concatenate on-device to the exact input.
//
// Both `input text` sinks — the phone keyboard path and the Android-TV blueprint's
// per-word typing — go through `injectAndroidText`, so this stays single-sourced.
function splitForVerbatimPercent(text: string): string[] {
  // Each `[^%]*%` chunk ends at (and includes) a `%`; the trailing `[^%]+` catches
  // the tail after the final `%`.
  return text.match(/[^%]*%|[^%]+/g) ?? [];
}

// `input` opens the app-process VM per call, so 15s covers a single injection on
// a slow CI emulator while still bounding a hung adb child.
const ADB_INPUT_TIMEOUT_MS = 15_000;

/** Type text into the focused field via `adb shell input text`. No-op for "". */
export async function injectAndroidText(serial: string, text: string): Promise<void> {
  assertTypeableAndroidText(text);
  // One call per segment (see `splitForVerbatimPercent`). "" yields no segments,
  // so the no-op for "" needs no separate guard.
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

// KEYCODE_FORWARD_DEL, the forward half of the pair the `clear` burst sends.
// Nothing in `ANDROID_NAMED_KEYCODES` names it: `delete` there is KEYCODE_DEL,
// backspace, following the shared HID vocabulary in
// ../tools/keyboard/key-codes.ts. The backward half is that same
// `ANDROID_NAMED_KEYCODES.backspace`, read from the table rather than repeated,
// so a change to the named key cannot silently disagree with the burst.
const KEYCODE_FORWARD_DEL = 112;

// The burst's own budget, and NOT `ADB_INPUT_TIMEOUT_MS`: that one is sized for
// a SINGLE injection, while this command carries 200 of them and `input` injects
// with INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH — so the adb child blocks on the
// app once per event, and the total is the app's per-keystroke cost times 200,
// not one VM start.
//
// Measured on a Pixel 7 AVD (API 36): 1.9s against a native EditText, but 14.9s
// against a debug Flutter field on an otherwise idle host — already at the 15s
// single-injection cap, and 16.3s with four busy loops on the guest, where adb
// was SIGKILLed with the field emptied from 300 characters to 200. 90s keeps a
// hung adb child bounded while leaving that margin.
export const ADB_CLEAR_TIMEOUT_MS = 90_000;

/**
 * Empty the focused text field: `CLEAR_KEY_PAIRS` backspaces interleaved with
 * as many forward-deletes, as ONE `input keyevent` invocation.
 *
 * Both directions, because the caret sits wherever the focus tap left it — a
 * backspace at a line start joins lines and a forward-delete at a line end does
 * too, so a multi-line field empties out from the middle without a caret move.
 * Pressing either key on an empty side is a no-op, so over-sending is harmless.
 *
 * Plain `input keyevent`, not `input keycombination`: a Ctrl+A select-all is
 * swallowed outright by Flutter, intermittently missed by React Native
 * (https://github.com/software-mansion/argent/pull/821), and carries no
 * `metaState` at all on API 31/32 — a primitive that can silently no-op needs a
 * read-back to be trusted, and this one cannot no-op. Multi-code `keyevent` has
 * been accepted since API 19, so one call carries the whole burst (2-15s on an
 * emulator, depending on the app's per-keystroke cost) instead of 200
 * round-trips.
 */
export async function injectAndroidClear(serial: string, signal?: AbortSignal): Promise<void> {
  const codes: number[] = [];
  const backspace = ANDROID_NAMED_KEYCODES.backspace!;
  for (let i = 0; i < CLEAR_KEY_PAIRS; i++) codes.push(backspace, KEYCODE_FORWARD_DEL);
  // Read BEFORE the call, because the answer is only knowable there. Node's
  // `execFile` with an already-aborted signal never spawns the child and rejects
  // with `code: "ABORT_ERR"` — which is not a spawn failure and matches no adb
  // client refusal, so `reachedTheDevice` answered `true` and the one case where
  // the code can PROVE nothing was sent was reported as "may be PARTIALLY
  // emptied". An abort that arrives once the child is running is a different
  // thing and keeps that wording: the burst may well have been delivered.
  const cancelledBeforeSend = signal?.aborted === true;
  try {
    // `signal` is the request's own abort — without it this call blocked for its
    // whole 90s budget after the caller had gone, and nothing killed the adb
    // child either.
    //
    // What it does and does NOT stop, measured on an API 36 emulator against a
    // native EditText holding 100 characters, with the client gone at 150ms and
    // at 1s: at 150ms the field is byte-identical afterwards (the command had
    // not reached the guest), at 1s the guest completed all 100 deletions. So
    // the abort kills the host-side adb client and stops the wait, and it
    // prevents the injection only while the command is still in flight — once
    // on-device `input` is running, nothing here reaches it. The iOS burst
    // (../tools/keyboard/simulator-server-keys.ts) writes key by key and can be
    // stopped mid-way; this one cannot, because the whole burst is a single
    // command by design.
    await adbShell(serial, `input keyevent ${codes.join(" ")}`, {
      timeoutMs: ADB_CLEAR_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    // Re-stated because the adb failure says nothing about a clear, and the
    // difference matters: the burst is not atomic, so a command killed partway
    // leaves the field emptied by however many pairs got through. An agent told
    // only "adb command failed" reads that as "nothing happened" and types over
    // a field that is now half its old length. The keycode list is dropped from
    // the message too — 200 numbers, which `formatSubprocessFailure` and Node's
    // own nested `Command failed:` each repeat into agent context.
    //
    // But "may be PARTIALLY emptied" must not be asserted for a failure where
    // nothing was sent. The adb CLIENT rejects an unreachable device before it
    // delivers anything (measured: `adb: device 'emulator-9999' not found`,
    // exit 1), and the leading sentence is the authoritative one — an agent
    // that believes it re-reads a field that never changed, with a `describe`
    // that fails on the same dead device.
    const delivered = !cancelledBeforeSend && reachedTheDevice(err);
    throw new FailureError(
      (delivered
        ? `the clear burst did not finish on ${serial}, and the focused field may be PARTIALLY ` +
          `emptied — the ${CLEAR_KEY_PAIRS * 2} delete keys are sent as one ` +
          "`adb shell input keyevent`, which is not " +
          "atomic. Read the field back (`describe`) before clearing or typing again. "
        : cancelledBeforeSend
          ? `the clear burst was cancelled before it was sent to ${serial}, so NO delete key was ` +
            "sent and the focused field is unchanged. The request had already been aborted — the " +
            "caller disconnected, or the run was cancelled — when the burst was due, so no adb " +
            "child was ever started. Nothing needs to be read back. "
          : `the clear burst never reached ${serial}: adb rejected the command before delivering ` +
            "it, so NO delete key was sent and the focused field is unchanged. This is a device " +
            "connection problem, not a field problem — check `list-devices` and retry the clear " +
            "once the device is back. ") +
        "Underlying failure: " +
        firstLine(err),
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
        failure_stage: "keyboard_clear_android_burst",
        failure_area: "tool_server",
        error_kind: getFailureSignal(err)?.error_kind ?? "subprocess",
        // Copied off `runAdb`'s OWN signal, not rebuilt from `err`. Every other
        // adb re-statement in the repo hands `subprocessFailureMetadata` the raw
        // `execFile` error; here `err` is already a `FailureError`, which keeps
        // its `code`/`signal` behind a non-enumerable symbol rather than as own
        // properties — so the spread recovered nothing and the SIGKILL from the
        // 90s cap, the failure this budget exists to bound, stayed
        // unrecoverable. Measured against a failing adb: `runAdb` reported
        // `failure_exit_code: 1` and the spread yielded `{ failure_command }`
        // alone.
        failure_command: "adb",
        ...subprocessMetadataOf(err),
      }
      // Deliberately NO `cause`: the message chain is rendered into agent
      // context, and the adb error quotes the whole `input keyevent` command
      // line — 200 keycodes, twice over (`formatSubprocessFailure` and node's
      // own nested "Command failed:"). `firstLine` below exists to strip it, and
      // a cause would put it straight back. The metadata spread is what makes
      // the exit code and signal recoverable.
    );
  }
}

/**
 * Whether the burst could have reached the guest at all.
 *
 * These are the adb CLIENT's own refusals, printed before any command is
 * delivered — so nothing was injected and the field is untouched. Everything
 * else (a non-zero exit from `input` itself, a timeout, the 90s cap's SIGKILL)
 * may have injected some of the 200 keys before it stopped.
 */
const ADB_NEVER_DELIVERED =
  /device '[^']*' not found|device offline|device unauthorized|no devices\/emulators found|more than one device|device still (?:connecting|authorizing)/i;

function reachedTheDevice(err: unknown): boolean {
  // A spawn failure means the adb binary itself never ran.
  if (getFailureSignal(err)?.failure_spawn_code !== undefined) return false;
  const message = err instanceof Error ? err.message : String(err);
  return !ADB_NEVER_DELIVERED.test(message);
}

/**
 * The subprocess half of an already-wrapped adb failure's signal, ready to
 * spread over a re-statement. Empty for a failure that carries none.
 */
function subprocessMetadataOf(
  err: unknown
): Pick<FailureSignal, "failure_exit_code" | "failure_signal" | "failure_spawn_code"> {
  const signal = getFailureSignal(err);
  if (!signal) return {};
  const { failure_exit_code, failure_signal, failure_spawn_code } = signal;
  return {
    ...(failure_exit_code === undefined ? {} : { failure_exit_code }),
    ...(failure_signal === undefined ? {} : { failure_signal }),
    ...(failure_spawn_code === undefined ? {} : { failure_spawn_code }),
  };
}

/**
 * The adb failure's own diagnosis, on one line, without the 200-keycode command
 * it quotes.
 *
 * A COLD adb prints its daemon banner before the error — two lines of
 * `* daemon …` — and a cold adb is likeliest on the first Android call of a
 * tool-server's life. Taking line 0 handed the caller
 * "…failed: * daemon not running; starting now at tcp:5037" and dropped
 * "adb: error: …", the only sentence that says what went wrong. The banner is
 * removed wherever it sits, including inline after `failed:`, and the real error
 * is pulled up to join the prefix it belongs to.
 */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message
    .replace(/\* daemon[^\n]*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = lines[0] ?? "";
  // With the banner gone, the head can end at its own `failed:` with adb's
  // error on the next line.
  const line = /failed:$/.test(head) && lines[1] !== undefined ? `${head} ${lines[1]}` : head;
  return line.replace(/input keyevent[\d ]*\d/g, "input keyevent <the delete burst>");
}

/** Press a named key (keyboard tool `key` vocabulary) on Android. */
export async function injectAndroidNamedKey(serial: string, name: string): Promise<void> {
  const lower = name.toLowerCase();
  // Own-property check: `key` is a free string, so "constructor" would otherwise
  // pass the nullish guard with Object.prototype.constructor.
  const keycode = Object.hasOwn(ANDROID_NAMED_KEYCODES, lower)
    ? ANDROID_NAMED_KEYCODES[lower]
    : undefined;
  if (keycode == null) {
    // Caller input error (HTTP 400); KEYBOARD_KEY_UNSUPPORTED matches the
    // iOS/chromium/vega backends (#420).
    throw new InvalidToolInputError(
      `Unknown key "${name}". Supported: ${Object.keys(ANDROID_NAMED_KEYCODES).join(", ")}`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "keyboard_named_key_android",
        error_kind: "unsupported",
      }
    );
  }
  await injectAndroidKeycode(serial, keycode);
}
