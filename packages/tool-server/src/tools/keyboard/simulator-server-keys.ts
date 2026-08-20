import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  A_KEYCODE,
  charToKeyPress,
  LEFT_GUI_KEYCODE,
  NAMED_KEYS,
  SHIFT_KEYCODE,
} from "./key-codes";
import { InvalidToolInputError } from "../../utils/capability";
import { sleepOrAbort } from "../../utils/timing";
import { deviceChainKey, serializePerDevice } from "./device-chain";
import type { KeyboardParams, KeyboardResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Type text / press named keys over the simulator-server (iOS simulator) using
// the HID keycode maps in key-codes.ts (with shift). Only the iOS keyboard
// branch uses this now — Android phones/tablets inject over `adb shell input`
// instead (see utils/android-input.ts, issue #449), so despite the shared-
// looking name this is no longer a shared iOS/Android transport.
export function typeSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  return serializePerDevice(deviceChainKey(device.id), () => {
    // Checked HERE, as this call's turn comes round, so a request the client has
    // already abandoned does not spend the device's keyboard — it leaves the
    // chain immediately and the next waiter starts. Without it a queue of
    // hung-up calls still typed every one of them out in full.
    signal?.throwIfAborted();
    return runSimulatorServerType(registry, device, params, signal);
  });
}

async function runSimulatorServerType(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  // Release every modifier this backend is capable of holding, before pressing
  // anything. HID `Up` on a key that is not down is a no-op, so this costs two
  // fire-and-forget writes and heals a modifier the guest is still holding from
  // an earlier run that never got to release it.
  //
  // Reachable, and measured: kill the tool-server inside the ~83ms window the
  // clear holds Left GUI (Ctrl-C, `argent kill`, a crash, the simulator-server
  // dying mid-flow) and Command stays latched in the guest. The next
  // `{ text: "h" }` then returns `{"typed":"h","keys":1}` while the device goes
  // to the Home screen — Cmd+H backgrounded the app and the page never saw the
  // character. It survives a tool-server restart and a simulator-server respawn,
  // nothing reads modifier state back, and no tool released it.
  const releaseHeldModifiers = () => {
    api.pressKey("Up", SHIFT_KEYCODE);
    api.pressKey("Up", LEFT_GUI_KEYCODE);
  };

  // Press `keyCode`, optionally while holding a modifier (shift for a capital,
  // Left GUI/Command for the select-all in a clear). The modifier is held across
  // the whole down/up pair so the guest sees a real chord, not two taps.
  //
  // The release is in a `finally` because modifier state lives in the GUEST and
  // a modifier left down stays down, turning every subsequent keystroke into a
  // chord — a stuck Shift only mis-cases text, a stuck Command runs system
  // shortcuts (Cmd+H backgrounds the app). The `finally` covers a throw; it does
  // NOT cover the tool-server process dying between the two writes, which is
  // what `releaseHeldModifiers` above exists for.
  //
  // The hold spans awaits, so a keystroke from a CONCURRENT call would land
  // inside the chord (measured: `{ text: "w" }` 15ms behind a `{ clear: true }`
  // reached the guest as Cmd+W and was never typed). That is why the whole run
  // is serialized per device — see `serializePerDevice`.
  const pressKeyCode = async (keyCode: number, modifierKeyCode?: number) => {
    if (modifierKeyCode !== undefined) {
      api.pressKey("Down", modifierKeyCode);
      await sleep(10);
    }
    try {
      api.pressKey("Down", keyCode);
      await sleep(delay);
      api.pressKey("Up", keyCode);
    } finally {
      if (modifierKeyCode !== undefined) {
        await sleep(10);
        api.pressKey("Up", modifierKeyCode);
      }
    }
  };

  // `keys` counts what the caller asked to be *entered* — one per character of
  // `text`, plus one for a named `key`. The clear's own presses are deliberately
  // excluded: they are an implementation detail of emptying the field, and what
  // that costs differs wildly per backend (two HID presses here; on Android
  // NO key events at all when the accessibility replace serves it, otherwise one
  // `input keycombination` plus a `KEYCODE_DEL`, or on a level without that
  // subcommand a MOVE_END plus one delete per character — up to 159 key events;
  // two CDP key events on Chromium). Counting them would make the same request
  // report a different `keys` on every platform — and on Android it would vary
  // by which path happened to be available. The clear is reported by `cleared`
  // instead, plus a `note` on Android when the weaker path ran.
  const pressAndCount = async (keyCode: number, modifierKeyCode?: number) => {
    await pressKeyCode(keyCode, modifierKeyCode);
    keysPressed++;
  };

  // Resolve the named key BEFORE anything is sent, because `clear` empties the
  // field: a `{ clear, key: "bogus" }` must reject with the field still intact
  // rather than emptied and then 400. (Not to protect the text — the tool
  // rejects `{ text, key }` above the dispatch, so a key never follows typing in
  // the same call; see the mutually-exclusive note further down.)
  let namedKeyCode: number | undefined;
  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: a prototype key like "constructor" would otherwise
    // pass the nullish guard with a garbage value (Object.prototype.constructor)
    // and go over the wire as a broken key press instead of rejecting.
    namedKeyCode = Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : undefined;
    if (namedKeyCode == null) {
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
  }

  // Resolve EVERY character before touching the device: no device write happens
  // until the whole request is known to be executable. Resolving per character
  // inside the loop below would let a `{ clear, text }` whose character 4 has no
  // keycode destroy the field's original value and leave a fragment behind, so a
  // call that returned 400 would leave the caller worse off than before it. Same
  // up-front-validation rule the android backend applies with
  // `assertTypeableAndroidText`.
  const presses = params.text
    ? [...params.text].map((char) => ({ char, press: charToKeyPress(char) }))
    : [];
  for (const { char, press } of presses) {
    // A character with no keycode can't be typed on this backend — a caller
    // input error → 400, keeping the KEYBOARD_CHARACTER_UNSUPPORTED telemetry
    // code (#420).
    if (!press)
      throw new InvalidToolInputError(`No keycode for character "${char}"`, {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "keyboard_char_simulator",
        error_kind: "unsupported",
      });
  }

  // Everything above only validates; this is the first device write, so a
  // rejected request still touches nothing.
  releaseHeldModifiers();

  // Clear before text: Cmd+A selects the field's whole contents, backspace
  // deletes the selection. Verified on a UIKit `UITextField` (Safari address
  // bar) and a React Native `TextInput` (Bluesky search) — on the latter the JS
  // `onChangeText("")` fires, so native view and React state agree.
  //
  // Deliberately ATOMIC with respect to the abort signal — checked before, never
  // between its two presses. Stopping after the Cmd+A would leave the field's
  // whole value selected, so the next character typed into it (by anything)
  // replaces the lot, and a cancelled request has no reader to be told that.
  if (params.clear) {
    signal?.throwIfAborted();
    await pressKeyCode(A_KEYCODE, LEFT_GUI_KEYCODE);
    await sleep(delay);
    await pressKeyCode(NAMED_KEYS.backspace);
    await sleep(delay);
  }

  // The signal is checked BETWEEN presses, and the cadence wait yields to it, so
  // an abandoned run stops within about one keypress instead of typing its whole
  // `text` out. Never inside `pressKeyCode`: cutting the wait between a key's
  // Down and its Up would leave that key held down in the guest, which is the
  // failure `releaseHeldModifiers` exists to heal.
  for (const { press } of presses) {
    signal?.throwIfAborted();
    await pressAndCount(press!.keyCode, press!.withShift ? SHIFT_KEYCODE : undefined);
    await sleepOrAbort(delay, signal);
  }

  // The tool rejects a request carrying both `text` and `key` (see ./index.ts),
  // so this branch and the text loop above are mutually exclusive. Only `clear`
  // combines with either, and it runs before both.
  if (namedKeyCode != null) {
    signal?.throwIfAborted();
    await pressAndCount(namedKeyCode);
  }

  return {
    typed: params.text ?? params.key ?? "",
    keys: keysPressed,
    ...(params.clear ? { cleared: true } : {}),
  };
}
