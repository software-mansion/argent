import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { charToKeyPress, NAMED_KEYS, SHIFT_KEYCODE } from "./key-codes";
import { InvalidToolInputError } from "../../utils/capability";
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

  if (params.key) {
    const code = NAMED_KEYS[params.key.toLowerCase()];
    if (code == null) {
      // Well-typed but unusable input (the schema's `key` is a free string) — a
      // caller mistake, so InvalidToolInputError (→400), matching the Android
      // path. A plain Error would surface as a 500 and diverge by platform.
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(NAMED_KEYS).join(", ")}`
      );
    }
    await pressKeyCode(code);
  }

  if (params.text) {
    for (const char of params.text) {
      const press = charToKeyPress(char);
      // A character with no keycode can't be typed on this backend — a caller
      // input error (→400), not an internal fault (500).
      if (!press) throw new InvalidToolInputError(`No keycode for character "${char}"`);
      await pressKeyCode(press.keyCode, press.withShift);
      await sleep(delay);
    }
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}
