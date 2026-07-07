import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import { InvalidToolInputError } from "../../utils/capability";
import type { KeyboardParams, KeyboardResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Type text / press named keys over the simulator-server (iOS simulator) using
// the HID keycode maps in key-codes.ts (with shift). Only the iOS keyboard
// branch uses this now — Android phones/tablets inject over `adb shell input`
// instead (see utils/android-input.ts, issue #449), so despite the shared-
// looking name this is no longer a shared iOS/Android transport.
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

  if (params.key) {
    const code = NAMED_KEYS[params.key.toLowerCase()];
    if (code == null) {
      // Well-typed but unusable input (the schema's `key` is a free string) — a
      // caller mistake, so InvalidToolInputError → HTTP 400, matching the Android
      // path and uniform across keyboard backends. The KEYBOARD_KEY_UNSUPPORTED
      // telemetry signal from #420 is preserved: the 400 mapping keys off the
      // error class, not the code.
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_simulator",
          error_kind: "unsupported",
        }
      );
    }
    await pressKeyCode(code);
  }

  if (params.text) {
    for (const char of params.text) {
      const press = charToKeyPress(char);
      // A character with no keycode can't be typed on this backend — a caller
      // input error → 400, keeping the KEYBOARD_CHARACTER_UNSUPPORTED telemetry
      // code (#420).
      if (!press)
        throw new InvalidToolInputError(`No keycode for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_simulator",
          error_kind: "unsupported",
        });
      await pressKeyCode(press.keyCode, press.withShift);
      await sleep(delay);
    }
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}
