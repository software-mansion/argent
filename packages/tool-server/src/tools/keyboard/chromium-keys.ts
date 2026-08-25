// CDP `Input.dispatchKeyEvent` descriptors for the keyboard tool: the same named
// keys accepted on iOS/Android (./key-codes.ts NAMED_KEYS), plus printable chars.
//
// key drives KeyboardEvent.key, code drives .code, windowsVirtualKeyCode drives
// the legacy .keyCode/.which — apps still reading keyCode see 0 unless all three
// are set.

export interface ChromiumNamedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

export const CHROMIUM_NAMED_KEYS: Record<string, ChromiumNamedKey> = {
  "enter": { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  "return": { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  "escape": { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  "esc": { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  "backspace": { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  "delete": { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  "tab": { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  "space": { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  "arrow-right": { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  "arrow-left": { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  "arrow-down": { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  "arrow-up": { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  "f1": { key: "F1", code: "F1", windowsVirtualKeyCode: 112 },
  "f2": { key: "F2", code: "F2", windowsVirtualKeyCode: 113 },
  "f3": { key: "F3", code: "F3", windowsVirtualKeyCode: 114 },
  "f4": { key: "F4", code: "F4", windowsVirtualKeyCode: 115 },
  "f5": { key: "F5", code: "F5", windowsVirtualKeyCode: 116 },
  "f6": { key: "F6", code: "F6", windowsVirtualKeyCode: 117 },
  "f7": { key: "F7", code: "F7", windowsVirtualKeyCode: 118 },
  "f8": { key: "F8", code: "F8", windowsVirtualKeyCode: 119 },
  "f9": { key: "F9", code: "F9", windowsVirtualKeyCode: 120 },
  "f10": { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  "f11": { key: "F11", code: "F11", windowsVirtualKeyCode: 122 },
  "f12": { key: "F12", code: "F12", windowsVirtualKeyCode: 123 },
};

/** CDP descriptor for one character; null outside printable ASCII plus tab/newline. */
export function charToChromiumKey(char: string): {
  key: string;
  code: string;
  text: string;
  windowsVirtualKeyCode: number;
} | null {
  if (char.length !== 1) return null;
  if (char === "\n" || char === "\r") {
    return { key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 };
  }
  if (char === "\t") {
    return { key: "Tab", code: "Tab", text: "\t", windowsVirtualKeyCode: 9 };
  }
  const cc = char.charCodeAt(0);
  if (cc >= 0x20 && cc <= 0x7e) {
    const upper = char.toUpperCase();
    const upperCc = upper.charCodeAt(0);
    if (upperCc >= 65 && upperCc <= 90) {
      return {
        key: char,
        code: `Key${upper}`,
        text: char,
        windowsVirtualKeyCode: upperCc,
      };
    }
    if (cc >= 48 && cc <= 57) {
      return {
        key: char,
        code: `Digit${char}`,
        text: char,
        windowsVirtualKeyCode: cc,
      };
    }
    // Punctuation: `text` carries the character, so `code` is left unmapped.
    return {
      key: char,
      code: "",
      text: char,
      windowsVirtualKeyCode: char === " " ? 32 : 0,
    };
  }
  return null;
}
