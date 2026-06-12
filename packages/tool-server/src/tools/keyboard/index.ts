import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { runVegaFastCli } from "../../utils/vega-fast-cli";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "./chromium-keys";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
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
  chromium: { app: true },
  vega: { virtual: true },
};

async function runChromium(api: ChromiumCdpApi, params: Params): Promise<Result> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  if (params.key) {
    const named = CHROMIUM_NAMED_KEYS[params.key.toLowerCase()];
    if (!named) {
      throw new Error(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`
      );
    }
    await api.dispatchKeyEvent({
      type: "keyDown",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    await sleep(delay);
    await api.dispatchKeyEvent({
      type: "keyUp",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    keysPressed++;
  }

  if (params.text) {
    for (const char of params.text) {
      const desc = charToChromiumKey(char);
      if (!desc) {
        throw new Error(`No CDP key descriptor for character "${char}"`);
      }
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      // `char` delivers the actual codepoint to the focused input; without
      // this the field receives no value.
      await api.dispatchKeyEvent({ type: "char", text: desc.text });
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      keysPressed++;
      await sleep(delay);
    }
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const keyboardTool: ToolDefinition<Params, Result> = {
  id: "keyboard",
  description: `Type text or press special keys on the device (iOS simulator, Android emulator, Chromium app, or Vega Virtual Device) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega, prefer the \`remote\` tool for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number }. Fails if an unsupported key name is provided or the backend is not reachable for the given device.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12)
Provide text, key, or both. Use instead of paste when paste is unreliable or unsupported by the focused field.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    if (device.platform === "vega") {
      return {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      return runChromium(chromium, params);
    }
    if (device.platform === "vega") {
      // Shell out to vega-fast-cli; it maps named keys + injects via the on-device server.
      let keysPressed = 0;
      if (params.key) {
        await runVegaFastCli(["key", params.key]);
        keysPressed++;
      }
      if (params.text) {
        await runVegaFastCli(["type", params.text]);
        keysPressed += [...params.text].length;
      }
      return { typed: params.text ?? params.key ?? "", keys: keysPressed };
    }
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
