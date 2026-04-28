import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { keyboardIos, type KeyboardResult, type KeyboardServices } from "./platforms/ios";
import { keyboardAndroid } from "./platforms/android";

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
  delayMs: z.number().optional().describe("Delay in ms between key presses (default 50)"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const keyboardTool: ToolDefinition<Params, KeyboardResult> = {
  id: "keyboard",
  description: `Type text or press special keys on the simulator using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys.
Returns { typed: string, keys: number }. Fails if an unsupported key name is provided or the simulator server is not running.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12)
Provide text, key, or both. Use instead of paste when paste is unreliable or unsupported by the focused field.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<KeyboardServices, Params, KeyboardResult>({
    toolId: "keyboard",
    capability,
    ios: keyboardIos,
    android: keyboardAndroid,
  }),
};
