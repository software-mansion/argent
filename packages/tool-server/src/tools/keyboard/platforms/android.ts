import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import {
  assertTypeableAndroidText,
  injectAndroidNamedKey,
  injectAndroidText,
} from "../../../utils/android-input";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeTv } from "./tv";

// Phones / tablets inject over `adb shell input` (text / keyevent), NOT the
// simulator-server's HID transport: the guest silently drops HID key events on
// AVDs created with `hw.keyboard = no` (routine for CI / headless), so the tool
// used to report success while typing nothing — issue #449. `adb input` lands
// regardless of `hw.keyboard`, on emulators (any config) and physical devices,
// and surfaces a non-zero exit as a throw. `device.id` is the adb serial.
async function typeAndroidPhone(
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  let keysPressed = 0;
  // Validate the text up front (a pure check, re-run harmlessly inside
  // `injectAndroidText`): a combined key+text request with un-typeable text
  // must reject with NO on-device side effect, not press the key and then 400.
  if (params.text) assertTypeableAndroidText(params.text);
  if (params.key) {
    await injectAndroidNamedKey(device.id, params.key);
    keysPressed++;
  }
  if (params.text) {
    await injectAndroidText(device.id, params.text);
    // `injectAndroidText` (via `assertTypeableAndroidText`) has already rejected
    // any non-ASCII, so every character here is a single codepoint and a single
    // UTF-16 unit — `.length` is the codepoint count (matching the tv /
    // simulator-server backends) without a spread.
    keysPressed += params.text.length;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
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
        : typeAndroidPhone(device, params),
  };
}
