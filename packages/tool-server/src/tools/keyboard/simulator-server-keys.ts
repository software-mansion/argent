import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import { InvalidToolInputError } from "../../utils/capability";
import type { KeyboardParams, KeyboardResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long a key stays down, whatever `delayMs` says. iOS auto-repeats a key
 * held long enough, and a key held down is exposed to that: if the simulator
 * stalls before the Up lands, the key repeats (#2030). Keeping the hold short
 * and fixed shrinks that window; `delayMs` is spent between keys instead,
 * where a stall only delays the next one. 20 ms is the hold `fill` already
 * presses backspace with. Mutable for tests only.
 */
export const KEY_HOLD = { ms: 20 };

// Android phones/tablets do not use this HID transport — they inject over
// `adb shell input` instead (utils/android-input.ts, #449).
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
    // Keys sent Down and not yet acknowledged Up, last pressed last.
    const down: number[] = [];
    const press = async (direction: "Down" | "Up", code: number) => {
      if (direction === "Down") down.push(code);
      await api.pressKey(direction, code);
      if (direction === "Up") down.splice(down.lastIndexOf(code), 1);
    };
    try {
      if (withShift) {
        await press("Down", SHIFT_KEYCODE);
        await sleep(10);
      }
      await press("Down", keyCode);
      await sleep(KEY_HOLD.ms);
      await press("Up", keyCode);
      if (withShift) {
        await sleep(10);
        await press("Up", SHIFT_KEYCODE);
      }
    } catch (err) {
      // A press that failed can still land: a Down the server took but did
      // not acknowledge in time arrives once it resumes. Without its Up the
      // key stays held and iOS repeats it or opens the accent pop-up
      // (#2030). So every key that went down gets an Up, best effort; an
      // extra Up for a key that is already up does nothing.
      for (const code of down.reverse()) await api.pressKey("Up", code).catch(() => {});
      throw err;
    }
    keysPressed++;
  };

  // The tool rejects text + key (./index.ts), so at most one block below runs.
  if (params.text) {
    for (const char of params.text) {
      const press = charToKeyPress(char);
      // Caller input error → 400 via the error class, so the granular
      // KEYBOARD_CHARACTER_UNSUPPORTED code survives (#420).
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

  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: a prototype key like "constructor" would otherwise
    // pass the nullish guard with a garbage value (Object.prototype.constructor).
    const namedKeyCode = Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : undefined;
    if (namedKeyCode == null) {
      // Schema-valid but unusable (`key` is a free string) — 400 via the error
      // class, so the KEYBOARD_KEY_UNSUPPORTED code survives (#420), matching
      // the Android path.
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_simulator",
          error_kind: "unsupported",
        }
      );
    }
    await pressKeyCode(namedKeyCode);
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}
