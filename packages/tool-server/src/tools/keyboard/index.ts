import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { KeyboardParams, KeyboardResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";
import { makeChromiumImpl } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id)."
    ),
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
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12. Not supported on TV targets — move focus with `tv-remote` (up/down/left/right) instead."
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50). Ignored on Vega, where text/keys are injected in a single shot."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// `keyboard` goes through `dispatchByPlatform`. The chromium branch resolves the
// CDP session and the vega branch injects over `adb` (`inputd-cli`); the
// ios/android branches runtime-probe their TV kind (TV is a `runtimeKind`, not a
// `platform`, so a tvOS sim is "ios" and an Android TV "android" by id shape)
// and route a TV target to the focus-driven backend, otherwise to the
// simulator-server (see platforms/{ios,android,chromium,vega,tv}.ts). No service
// is declared eagerly: distinguishing a TV target is async, and declaring
// simulator-server up front would also spawn it for a tvOS udid it can't drive.
export function createKeyboardTool(registry: Registry): ToolDefinition<Params, KeyboardResult> {
  return {
    id: "keyboard",
    description: `Type text or press special keys on the device (iOS simulator, Android emulator, Chromium app, Vega Virtual Device, or Apple TV / Android TV) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega and Apple TV / Android TV, prefer the remote tools for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number }. Fails if an unsupported key name is provided or the simulator-server / emulator backend / Chromium CDP / Vega adb / TV control daemons are not reachable for the given device.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12) — NOT supported on TV targets; move focus with \`tv-remote\` instead.
On a TV target (runtimeKind 'tv') only \`text\` applies — focus a text field first (with \`tv-remote\`), then type into it (injected HID keyboard on Apple TV, \`adb input text\` on Android TV).
Provide text, key, or both. Use instead of paste when paste is unreliable or unsupported by the focused field.`,
    zodSchema,
    capability,
    searchHint:
      "type text keyboard input named key enter escape arrow tv vega fire tv search field hid leanback",
    // No eager service: each branch resolves its backend lazily (TV control,
    // simulator-server, CDP, or Vega adb), since distinguishing a TV target is
    // async and a tvOS udid must never resolve simulator-server.
    services: () => ({}),
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      KeyboardParams,
      KeyboardResult,
      Record<string, unknown>,
      Record<string, unknown>
    >({
      toolId: "keyboard",
      capability,
      ios: makeIosImpl(registry),
      android: makeAndroidImpl(registry),
      chromium: makeChromiumImpl(registry),
      vega: vegaImpl,
    }),
  };
}
