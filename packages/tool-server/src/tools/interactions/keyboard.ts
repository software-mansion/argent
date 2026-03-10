import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// USB HID Keyboard Usage Page (0x07) keycodes
const CHAR_TO_KEYCODE: Record<string, number> = {
  a: 4, b: 5, c: 6, d: 7, e: 8, f: 9, g: 10, h: 11,
  i: 12, j: 13, k: 14, l: 15, m: 16, n: 17, o: 18, p: 19,
  q: 20, r: 21, s: 22, t: 23, u: 24, v: 25, w: 26, x: 27,
  y: 28, z: 29,
  "1": 30, "2": 31, "3": 32, "4": 33, "5": 34,
  "6": 35, "7": 36, "8": 37, "9": 38, "0": 39,
  "\n": 40, "\r": 40,
  "\t": 43,
  " ": 44,
  "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49,
  ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
};

// Characters that require Shift — maps to the base key
const SHIFT_CHARS: Record<string, string> = {
  A: "a", B: "b", C: "c", D: "d", E: "e", F: "f", G: "g", H: "h",
  I: "i", J: "j", K: "k", L: "l", M: "m", N: "n", O: "o", P: "p",
  Q: "q", R: "r", S: "s", T: "t", U: "u", V: "v", W: "w", X: "x",
  Y: "y", Z: "z",
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};

const SHIFT_KEYCODE = 225; // USB HID Left Shift

const NAMED_KEYS: Record<string, number> = {
  enter: 40, return: 40,
  escape: 41, esc: 41,
  backspace: 42, delete: 42,
  tab: 43,
  space: 44,
  "arrow-right": 79, "arrow-left": 80, "arrow-down": 81, "arrow-up": 82,
  f1: 58, f2: 59, f3: 60, f4: 61, f5: 62, f6: 63,
  f7: 64, f8: 65, f9: 66, f10: 67, f11: 68, f12: 69,
};

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  text: z
    .string()
    .optional()
    .describe(
      "Text to type character by character. Handles uppercase and common punctuation. Use when paste is unreliable."
    ),
  key: z
    .string()
    .optional()
    .describe(
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12"
    ),
  delayMs: z
    .number()
    .optional()
    .describe("Delay in ms between key presses (default 50)"),
});

export const keyboardTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { typed: string; keys: number }
> = {
  id: "keyboard",
  description: `Type text or press special keys on the simulator using keyboard events.
Use instead of paste when paste is unreliable or unsupported by the focused field.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12)
Provide text, key, or both.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    const delay = params.delayMs ?? 50;
    let keysPressed = 0;

    const pressKeyCode = async (keyCode: number, withShift = false) => {
      if (withShift) {
        api.pressKey("Down", SHIFT_KEYCODE);
        await sleep(10);
      }
      api.pressKey("Down", keyCode);
      await sleep(delay);
      api.pressKey("Up", keyCode);
      if (withShift) {
        await sleep(10);
        api.pressKey("Up", SHIFT_KEYCODE);
      }
      keysPressed++;
    };

    if (params.key) {
      const code = NAMED_KEYS[params.key.toLowerCase()];
      if (code == null) {
        throw new Error(
          `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`
        );
      }
      await pressKeyCode(code);
    }

    if (params.text) {
      for (const char of params.text) {
        const base = SHIFT_CHARS[char];
        if (base !== undefined) {
          const code = CHAR_TO_KEYCODE[base];
          if (code == null) throw new Error(`No keycode for character "${char}"`);
          await pressKeyCode(code, true);
        } else {
          const code = CHAR_TO_KEYCODE[char];
          if (code == null) throw new Error(`No keycode for character "${char}"`);
          await pressKeyCode(code);
        }
        await sleep(delay);
      }
    }

    return { typed: params.text ?? params.key ?? "", keys: keysPressed };
  },
};
