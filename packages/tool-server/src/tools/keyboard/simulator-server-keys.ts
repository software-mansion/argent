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
import type { KeyboardParams, KeyboardResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One in-flight typing run per device, chained.
 *
 * Modifier state lives in the GUEST, and this backend holds a modifier down
 * across awaits so the guest sees a real chord (see `pressKeyCode`). Nothing
 * else serializes tool calls against a device — the registry hands concurrent
 * calls the same session and the transport writes immediately — so a second
 * `keyboard` call arriving inside that window has its keystroke delivered as
 * part of the chord: with Left GUI held, `{ text: "w" }` reaches the guest as
 * Cmd+W (an app `UIKeyCommand` or a system shortcut) and the character is never
 * typed, while the call still reports it as typed. Shift had the same window
 * before `clear` existed, where the worst outcome was a mis-cased character;
 * Command is the modifier that makes it destructive.
 *
 * Chaining, not rejecting: overlapping calls are a legitimate thing for a caller
 * to do, they just cannot interleave. Each device's chain is dropped once it
 * drains, so this holds no state for an idle device.
 */
const typeChains = new Map<string, Promise<void>>();

function serializePerDevice<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
  const previous = typeChains.get(deviceId) ?? Promise.resolve();
  const result = previous.then(run);
  // What gets STORED is a tail that never rejects, so a call that threw neither
  // blocks the queue behind it nor leaves an unhandled rejection on a promise
  // nobody awaits. The caller still gets `result`, rejection and all.
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  typeChains.set(deviceId, tail);
  void tail.then(() => {
    // Only drop the slot when nothing queued behind this call, so a waiter is
    // never handed a drained chain and allowed to overtake the run in flight.
    if (typeChains.get(deviceId) === tail) typeChains.delete(deviceId);
  });
  return result;
}

// Type text / press named keys over the simulator-server (iOS simulator) using
// the HID keycode maps in key-codes.ts (with shift). Only the iOS keyboard
// branch uses this now — Android phones/tablets inject over `adb shell input`
// instead (see utils/android-input.ts, issue #449), so despite the shared-
// looking name this is no longer a shared iOS/Android transport.
export function typeSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  // Case-folded, because `device.id` is the caller's own string verbatim
  // (`resolveDevice` classifies an iOS UDID by shape and never canonicalises
  // it), while the modifier state this serializes lives in the GUEST and is
  // shared by every spelling. Measured on an iPhone 17 Pro simulator, 7/7: a
  // `{ text: "w" }` addressed in lowercase ran INSIDE the Left GUI hold of a
  // `{ clear: true }` addressed in uppercase, and the `w` never reached the
  // field while the call reported it as typed — the exact corruption this chain
  // exists to prevent. No two distinct devices can collide under case-folding:
  // an adb serial and a chromium id are already lower-case, and a UDID is hex.
  return serializePerDevice(device.id.toLowerCase(), () =>
    runSimulatorServerType(registry, device, params)
  );
}

async function runSimulatorServerType(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
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
  // that costs differs wildly per backend (two HID presses here; on Android one
  // `input keycombination` plus a `KEYCODE_DEL`, or on a level without that
  // subcommand a MOVE_END plus one delete per character — up to 159 key events;
  // two CDP key events on Chromium). Counting them would make the same request
  // report a different `keys` on every platform. The clear is reported by
  // `cleared` instead.
  const pressAndCount = async (keyCode: number, modifierKeyCode?: number) => {
    await pressKeyCode(keyCode, modifierKeyCode);
    keysPressed++;
  };

  // Resolve the named key BEFORE the clear: `clear` empties the field, so an
  // unknown key name has to reject with the field still intact rather than
  // emptied and then 400. (`text` and `key` are never both present — the tool
  // rejects that shape, see ./index.ts.)
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
  if (params.clear) {
    await pressKeyCode(A_KEYCODE, LEFT_GUI_KEYCODE);
    await sleep(delay);
    await pressKeyCode(NAMED_KEYS.backspace);
    await sleep(delay);
  }

  for (const { press } of presses) {
    await pressAndCount(press!.keyCode, press!.withShift ? SHIFT_KEYCODE : undefined);
    await sleep(delay);
  }

  if (namedKeyCode != null) {
    await pressAndCount(namedKeyCode);
  }

  return {
    typed: params.text ?? params.key ?? "",
    keys: keysPressed,
    ...(params.clear ? { cleared: true } : {}),
  };
}
