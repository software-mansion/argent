import type { DeviceInfo, InvokeToolOptions, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import { assertTypeableAndroidText, injectAndroidNamedKey } from "../../../utils/android-input";
import type { KeyboardParams, KeyboardResult, KeyboardVerification } from "../types";
import { typeAndroidTextVerified } from "./android-verify";
import { typeTv } from "./tv";

// Phones / tablets inject over `adb shell input`, not the simulator-server's HID
// transport: the guest silently drops HID key events on `hw.keyboard = no` AVDs
// (routine for CI / headless), so the tool reported success while typing nothing
// (#449). `device.id` is the adb serial.
//
// A clean adb exit is not proof the characters arrived, though: `input text`
// injects them as one uninterrupted KeyEvent burst that a field re-rendering per
// keystroke drops parts of. So `text` goes through `typeAndroidTextVerified`,
// which reads the focused field back and reports what actually landed — see
// android-verify.ts. Named keys are single events and need no read-back.
async function typeAndroidPhone(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  options?: InvokeToolOptions
): Promise<KeyboardResult> {
  let keysPressed = 0;
  let verification: KeyboardVerification = {};
  // `text` and `key` are at-most-one (rejected in ../index.ts), so at most one
  // branch runs and there is no ordering to get right.
  if (params.text) {
    // `typeAndroidTextVerified` resolves the android-devtools helper — up to an
    // `adb install -t` of its APK — before it injects, so text this backend
    // cannot type has to be rejected ahead of that. `injectAndroidText` re-runs
    // the same pure check harmlessly.
    assertTypeableAndroidText(params.text);
    // The signal, not just the text: the read-back's repair deletes before it
    // retypes, and that must not start after the caller has gone away.
    verification = await typeAndroidTextVerified(registry, device, params.text, options?.signal);
    // `assertTypeableAndroidText` above has already rejected any non-ASCII, so
    // every character here is a single codepoint and a single UTF-16 unit —
    // `.length` is the codepoint count (matching the tv / simulator-server
    // backends) without a spread. It counts the characters the call asked to
    // type, not the presses a repair re-sent.
    keysPressed += params.text.length;
  }
  if (params.key) {
    await injectAndroidNamedKey(device.id, params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed, ...verification };
}

// An Android TV emulator classifies as platform "android" by serial shape, and TV
// is a `runtimeKind` rather than a `platform`, so this branch probes the kind at
// runtime and routes a TV target to the focus-driven backend.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // Both sub-paths shell out to `adb` (the `isAndroidTv` probe, then `input`
    // either way), so declaring it makes a missing binary fail with
    // `dispatchByPlatform`'s 424 install hint instead of from inside the probe.
    requires: ["adb"],
    handler: async (_services, params, device, options) =>
      (await isAndroidTv(device.id))
        ? typeTv(registry, device, params)
        : typeAndroidPhone(registry, device, params, options),
  };
}
