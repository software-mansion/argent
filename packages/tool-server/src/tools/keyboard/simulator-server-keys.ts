import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import type { KeyboardParams, KeyboardResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Type text / press named keys over the simulator-server (iOS sim / Android
// emulator). Characters go through per-platform keycode maps with shift. Shared
// by the ios and android platform branches — the simulator-server transport is
// identical for both — so it lives here rather than in either platform file.
export async function typeSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
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

  // Resolve the named key before typing anything so an unknown name fails
  // fast instead of after the text has already been typed.
  let namedKeyCode: number | undefined;
  if (params.key) {
    namedKeyCode = NAMED_KEYS[params.key.toLowerCase()];
    if (namedKeyCode == null) {
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

  // Key after text: a combined call means "type, then submit" (text +
  // key:"enter"). Pressing the key first fires enter into the still-empty
  // field, which can blur it and leak the text to app-level key commands
  // (e.g. "d" toggles the React Native dev menu when nothing is focused).
  if (namedKeyCode != null) {
    await pressKeyCode(namedKeyCode);
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}
