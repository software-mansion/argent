// USB HID Keyboard Usage Page (0x07) keycodes.
// Reference: https://gist.github.com/MightyPork/6da26e382a7ad91b5496ee55fdc73db2

export const SHIFT_KEYCODE = 225;

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

export interface KeyPress {
  keyCode: number;
  withShift: boolean;
}

/** Resolve a single character into the HID keycode + shift modifier required to type it. */
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
  // Shifted punctuation (!@#$ …) — resolve the unshifted base char, then add shift.
  // The base may be a digit (1–9, 0), so recurse rather than looking up SYMBOL_KEYCODES directly.
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
