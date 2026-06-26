import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { injectVegaNamedKey, injectVegaText } from "../../utils/vega-input";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "./chromium-keys";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id)."
    ),
  text: z
    .string()
    .optional()
    .describe("Text to type character by character. Handles uppercase and common punctuation."),
  key: z
    .string()
    .optional()
    .describe(
      "Named key to press: enter, escape, backspace, tab, space, arrow-up, arrow-down, arrow-left, arrow-right, f1–f12"
    ),
  delayMs: z
    .number()
    .optional()
    .describe(
      "Delay in ms between key presses (default 50). Ignored on Vega, where text/keys are injected in a single shot."
    ),
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
  vega: { vvd: true },
};

interface SimulatorServerServices {
  simulatorServer: SimulatorServerApi;
}

interface ChromiumServices {
  chromium: ChromiumCdpApi;
}

async function runChromium(api: ChromiumCdpApi, params: Params): Promise<Result> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  if (params.key) {
    const named = CHROMIUM_NAMED_KEYS[params.key.toLowerCase()];
    if (!named) {
      throw new FailureError(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_chromium",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
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
        throw new FailureError(`No CDP key descriptor for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_chromium",
          failure_area: "tool_server",
          error_kind: "unsupported",
        });
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

// Shared iOS / Android path: both drive the bundled simulator-server binary via
// its `pressKey` command (USB HID keycodes). The blueprint factory that backs
// `services.simulatorServer` already preflights the platform binary (adb on
// Android, automation on iOS), so these branches declare no `requires`.
async function runSimulatorServer(api: SimulatorServerApi, params: Params): Promise<Result> {
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
      throw new FailureError(
        `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_simulator",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }
    await pressKeyCode(code);
  }

  if (params.text) {
    for (const char of params.text) {
      const press = charToKeyPress(char);
      if (!press)
        throw new FailureError(`No keycode for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_simulator",
          failure_area: "tool_server",
          error_kind: "unsupported",
        });
      await pressKeyCode(press.keyCode, press.withShift);
      await sleep(delay);
    }
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

// Vega has no simulator-server: input is injected over `adb` (on-device
// `inputd-cli`). The `adb` dependency is declared on the vega dispatch branch's
// `requires` and preflighted by dispatchByPlatform before this runs, so a
// missing adb fails with a clean 424 install hint rather than a spawn ENOENT.
async function runVega(params: Params): Promise<Result> {
  let keysPressed = 0;
  if (params.key) {
    await injectVegaNamedKey(params.key);
    keysPressed++;
  }
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const keyboardTool: ToolDefinition<Params, Result> = {
  id: "keyboard",
  description: `Type text or press special keys on the device (iOS simulator, Android emulator, Chromium app, or Vega Virtual Device) using keyboard events.
Use when you need to enter text or trigger a named key such as enter, escape, or arrow keys. On Vega, prefer the \`tv-remote\` tool for D-pad navigation; use keyboard to type into a focused text field (e.g. a search or login box).
Returns { typed: string, keys: number }. Fails if an unsupported key name is provided or the backend is not reachable for the given device.
- text: types a string character by character (supports uppercase, digits, common punctuation)
- key: presses a single named key (enter, escape, backspace, tab, arrow-up/down/left/right, f1–f12)
Provide text, key, or both.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    if (device.platform === "vega") {
      // Vega has no simulator-server: the bundled simulator-server binary only
      // backs iOS/Android, so it can't carry Vega input. Vega instead injects
      // over `adb` (on-device `inputd-cli`) — a separate transport, not a second
      // copy of the simulator-server. No blueprint service to resolve here; the
      // `adb` dependency is declared on the vega dispatch branch's `requires`.
      return {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  execute: dispatchByPlatform<
    SimulatorServerServices,
    SimulatorServerServices,
    Params,
    Result,
    ChromiumServices,
    Record<string, unknown>
  >({
    toolId: "keyboard",
    capability,
    ios: {
      handler: (services, params) => runSimulatorServer(services.simulatorServer, params),
    },
    android: {
      handler: (services, params) => runSimulatorServer(services.simulatorServer, params),
    },
    chromium: {
      handler: (services, params) => runChromium(services.chromium, params),
    },
    vega: {
      requires: ["adb"],
      handler: (_services, params) => runVega(params),
    },
  }),
};
