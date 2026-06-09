import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
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
  delayMs: z.number().optional().describe("Delay in ms between key presses (default 50)"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  typed: string;
  keys: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const keyboardTool: ToolDefinition<Params, Result> = {
  id: "keyboard",
  description: `Type text or press special keys on the device (iOS simulator or Android emulator) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys.
Returns { typed: string, keys: number }. Fails if an unsupported key name is provided or the simulator-server / emulator backend is not reachable for the given device.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12)
Provide text, key, or both. Use instead of paste when paste is unreliable or unsupported by the focused field.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
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
        const press = charToKeyPress(char);
        if (!press) throw new Error(`No keycode for character "${char}"`);
        await pressKeyCode(press.keyCode, press.withShift);
        await sleep(delay);
      }
    }

    return { typed: params.text ?? params.key ?? "", keys: keysPressed };
  },
};
