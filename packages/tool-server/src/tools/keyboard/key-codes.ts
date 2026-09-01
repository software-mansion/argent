// USB HID Keyboard Usage Page (0x07) keycodes.
// https://gist.github.com/MightyPork/6da26e382a7ad91b5496ee55fdc73db2

export const SHIFT_KEYCODE = 225;

// Keyboard DELETE Forward (0x4C). Not in NAMED_KEYS: this table's own `delete`
// is usage 42, backspace, so nothing here can reach 76 — it exists only for the
// `clear` burst, which pairs it with 42 to empty a field from either side of
// the caret.
//
// The `key` vocabulary is NOT uniform on this point across backends, and adding
// a name for 76 would have to be decided for all of them at once: `delete` is
// backspace on iOS (above) and on Android (../../utils/android-input.ts, KEYCODE_DEL
// 67), but the FORWARD delete on chromium (./chromium-keys.ts, VK 46). With the
// caret between `b` and `c` in `abc`, `key: "delete"` therefore leaves `ac` on
// the first two and `ab` on the last. That divergence predates the clear burst
// and is unchanged by it; it is recorded here because this is where the next
// name would be added.
//
// Vega maps `delete` to KEY_DELETE (../../utils/vega-input.ts), which READS like
// the chromium case and is not: measured on an OS 1.1 VVD, KEY_DELETE deletes
// BACKWARD, so `key: "delete"` leaves `ac` there too. That is why the Vega clear
// burst sends backspaces alone — there is no forward delete on the platform for
// it to interleave.
export const FORWARD_DELETE_KEYCODE = 76;

// `clear` sends this many (backspace, forward-delete) pairs — 200 key events —
// to whatever holds keyboard focus. Bounded on purpose: there is no read-back,
// so the burst has to be a fixed size, and 100 characters on each side of the
// caret covers the fields an agent types into. A longer value keeps its
// remainder, and the documented repair is a second `clear` call.
//
// "On each side" is the capacity, not the throughput: a tap into a filled field
// lands the caret at the END, where only the backspaces do anything, so one call
// clears 100 characters rather than 200 — measured at 250 -> 150 -> 50 -> 0 over
// three calls on a real simulator. `argent-device-interact/SKILL.md` states it
// that way to callers.
//
// Shared by every key-injecting backend — ../../utils/android-input.ts (phones,
// tablets and Android TV), ./simulator-server-keys.ts (iPhone/iPad simulators),
// ../../blueprints/tv-control.ts (Apple TV) and ../../utils/vega-input.ts
// (Vega) — so every one of them sends the same NUMBER of keys, which is what the
// tool description's `keys: 200` promises. Chromium clears through the DOM
// instead and does not use it.
//
// Vega is the one place the "on each side" reading does not apply: it has no
// forward delete (see the note on FORWARD_DELETE_KEYCODE above), so its burst is
// `CLEAR_KEY_PAIRS * 2` backspaces and covers 200 characters before the caret
// and none after it.
export const CLEAR_KEY_PAIRS = 100;

const SYMBOL_KEYCODES: Record<string, number> = {
  "\n": 40,
  "\r": 40,
  "\t": 43,
  " ": 44,
  "-": 45,
  "=": 46,
  "[": 47,
  "]": 48,
  "\\": 49,
  ";": 51,
  "'": 52,
  "`": 53,
  ",": 54,
  ".": 55,
  "/": 56,
};

const SHIFTED_SYMBOLS: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  "_": "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "~": "`",
  "<": ",",
  ">": ".",
  "?": "/",
};

export const NAMED_KEYS: Record<string, number> = {
  "enter": 40,
  "return": 40,
  "escape": 41,
  "esc": 41,
  "backspace": 42,
  "delete": 42,
  "tab": 43,
  "space": 44,
  "arrow-right": 79,
  "arrow-left": 80,
  "arrow-down": 81,
  "arrow-up": 82,
  "f1": 58,
  "f2": 59,
  "f3": 60,
  "f4": 61,
  "f5": 62,
  "f6": 63,
  "f7": 64,
  "f8": 65,
  "f9": 66,
  "f10": 67,
  "f11": 68,
  "f12": 69,
};

interface KeyPress {
  keyCode: number;
  withShift: boolean;
}

/** HID keycode + shift modifier needed to type `char`. */
export function charToKeyPress(char: string): KeyPress | undefined {
  if (char.length !== 1) return undefined;
  const c = char.charCodeAt(0);
  // a–z → 4–29
  if (c >= 0x61 && c <= 0x7a) return { keyCode: c - 0x61 + 4, withShift: false };
  // A–Z → 4–29 with shift
  if (c >= 0x41 && c <= 0x5a) return { keyCode: c - 0x41 + 4, withShift: true };
  // 1–9 → 30–38, 0 → 39
  if (c >= 0x31 && c <= 0x39) return { keyCode: c - 0x31 + 30, withShift: false };
  if (char === "0") return { keyCode: 39, withShift: false };
  // Base may be a digit, which SYMBOL_KEYCODES omits — hence the recursion.
  const base = SHIFTED_SYMBOLS[char];
  if (base !== undefined) {
    const basePress = charToKeyPress(base);
    if (basePress === undefined) return undefined;
    return { keyCode: basePress.keyCode, withShift: true };
  }
  const code = SYMBOL_KEYCODES[char];
  if (code === undefined) return undefined;
  return { keyCode: code, withShift: false };
}
