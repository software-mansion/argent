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
import { FAILURE_CODES } from "@argent/registry";
import { adbShell, shellQuote } from "./adb";
import { InvalidToolInputError } from "./capability";

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

/**
 * Press one keycode `count` times in a single `adb shell input keyevent` call.
 * `input keyevent` takes a whole list of keycodes and injects them from one
 * `app_process` boot, so a run of presses costs one call's startup instead of
 * `count` of them — the difference between well under a second and half a
 * minute for the tens of backspaces the keyboard read-back's undo needs. A
 * non-positive `count` is a no-op rather than a bare `input keyevent` (which
 * would exit non-zero on a usage error).
 */
export async function injectAndroidKeycodeRepeated(
  serial: string,
  keycode: number,
  count: number
): Promise<void> {
  if (count <= 0) return;
  const codes = new Array<number>(count).fill(keycode).join(" ");
  await adbShell(serial, `input keyevent ${codes}`, { timeoutMs: ADB_INPUT_TIMEOUT_MS });
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
