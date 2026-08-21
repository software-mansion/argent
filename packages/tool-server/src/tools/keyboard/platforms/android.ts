import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import { assertTypeableAndroidText, injectAndroidNamedKey } from "../../../utils/android-input";
import type { KeyboardParams, KeyboardResult, KeyboardVerification } from "../types";
import { typeAndroidTextVerified } from "./android-verify";
import { typeTv } from "./tv";

// Phones / tablets inject over `adb shell input` (text / keyevent), NOT the
// simulator-server's HID transport: the guest silently drops HID key events on
// AVDs created with `hw.keyboard = no` (routine for CI / headless), so the tool
// used to report success while typing nothing — issue #449. `adb input` lands
// regardless of `hw.keyboard`, on emulators (any config) and physical devices,
// and surfaces a non-zero exit as a throw. `device.id` is the adb serial.
//
// A clean adb exit is not proof the characters arrived, though: `input text`
// injects them as one uninterrupted KeyEvent burst that a field re-rendering per
// keystroke drops parts of. So `text` goes through `typeAndroidTextVerified`,
// which reads the focused field back and reports what actually landed — see
// android-verify.ts. Named keys are single events and need no read-back.
async function typeAndroidPhone(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  let keysPressed = 0;
  let verification: KeyboardVerification = {};
  // The tool rejects a request carrying both `text` and `key` (see ../index.ts),
  // so at most one of these two branches runs — there is no ordering to get right
  // here, and no combined request whose halves could disagree.
  if (params.text) {
    // `typeAndroidTextVerified` resolves the android-devtools helper — up to an
    // `adb install -t` of its APK — before it injects, so text this backend
    // cannot type has to be rejected ahead of that. `injectAndroidText` re-runs
    // the same pure check harmlessly.
    assertTypeableAndroidText(params.text);
    verification = await typeAndroidTextVerified(registry, device, params.text);
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

// An Android TV emulator classifies as platform "android" by serial shape, so
// this branch handles both phones/tablets (`adb input`) and Android TV
// (focus-driven typing → `adb input text`). TV is a `runtimeKind`, not a
// `platform`, so the kind is an async runtime probe.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // Both sub-paths shell out to `adb`: the `isAndroidTv` probe up front, then
    // `adb input` either way (TV via the focus daemon, phone via `input text` /
    // `input keyevent`). Declare it so `dispatchByPlatform` preflights adb and a
    // missing binary fails with the clean 424 install hint rather than surfacing
    // from deeper in the probe. Matches the android branch of `describe` and
    // `tv-remote`.
    requires: ["adb"],
    handler: async (_services, params, device) =>
      (await isAndroidTv(device.id))
        ? typeTv(registry, device, params)
        : typeAndroidPhone(registry, device, params),
  };
}
