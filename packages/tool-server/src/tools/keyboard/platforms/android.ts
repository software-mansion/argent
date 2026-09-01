import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { getAndroidRuntimeKind } from "../../../utils/adb";
import {
  injectAndroidClear,
  injectAndroidNamedKey,
  injectAndroidText,
} from "../../../utils/android-input";
import { CLEAR_KEY_PAIRS } from "../key-codes";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeTv } from "./tv";

// Phones / tablets inject over `adb shell input`, not the simulator-server's HID
// transport: the guest silently drops HID key events on `hw.keyboard = no` AVDs
// (routine for CI / headless), so the tool reported success while typing nothing
// (#449). `device.id` is the adb serial.
async function typeAndroidPhone(
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  // `clear` empties the field with a fixed key burst rather than typing, so it
  // returns before the `typed`/`keys` arithmetic below: there is nothing typed
  // to count and nothing to echo. `cleared` reports that the burst was SENT —
  // the field is never read back.
  if (params.clear === true) {
    await injectAndroidClear(device.id, signal);
    return { typed: "", keys: CLEAR_KEY_PAIRS * 2, cleared: true };
  }
  let keysPressed = 0;
  // `text`, `key` and `clear` are at-most-one (rejected in ../index.ts), so at
  // most one branch runs and there is no ordering to get right.
  if (params.text) {
    await injectAndroidText(device.id, params.text);
    // `injectAndroidText` rejects non-ASCII, so `.length` is the codepoint count
    // (matching the tv / simulator-server backends).
    keysPressed += params.text.length;
  }
  if (params.key) {
    await injectAndroidNamedKey(device.id, params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

// An Android TV emulator classifies as platform "android" by serial shape, and TV
// is a `runtimeKind` rather than a `platform`, so this branch probes the kind at
// runtime and routes a TV target to the focus-driven backend.
//
// The kind is read as three-valued rather than through `isAndroidTv`, which
// collapses "not a TV" and "could not tell" into `false`. `readRuntimeKind`
// (utils/adb.ts) answers undefined when `pm list features` does not come back
// within its 5s budget and `ro.build.characteristics` carries no `tv` token —
// which is exactly what the Google ATV emulator reports (`emulator`). A first
// probe that times out mid-boot or under load therefore used to aim the 200-key
// burst at a TV, the one thing platforms/tv.ts exists to refuse, and `undefined`
// is not cached so every call is exposed to it.
//
// `text` is unaffected either way: on Android TV `TvControlApi.type` IS
// `adb shell input text` (../../../blueprints/android-tv-control.ts), the same
// channel the phone path uses. Only `key` and `clear` are refused on a TV, so
// only they need the kind to be known.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // Both sub-paths shell out to `adb` (the kind probe, then `input` either
    // way), so declaring it makes a missing binary fail with
    // `dispatchByPlatform`'s 424 install hint instead of from inside the probe.
    requires: ["adb"],
    handler: async (_services, params, device, options) => {
      const needsKind = params.clear === true || params.key !== undefined;
      let kind = await getAndroidRuntimeKind(device.id);
      // One re-probe, and only for the two shapes that need the answer: an
      // indeterminate verdict is never cached, so this is a real second read and
      // a probe that timed out under a load spike usually resolves here.
      if (kind === undefined && needsKind) kind = await getAndroidRuntimeKind(device.id);
      if (kind === "tv") return typeTv(registry, device, params);
      if (kind === undefined && needsKind) {
        throw new FailureError(
          `whether ${device.id} is a phone/tablet or an Android TV could not be determined, and ` +
            (params.clear === true ? "`clear`" : "`key`") +
            " means different things on the two — nothing was sent. It is refused rather than " +
            "guessed: " +
            // The reason is templated with the field name above it. Left static,
            // a refused `{ key: "enter" }` was told the request would have burst
            // 200 delete keys, which is a different request's justification.
            (params.clear === true
              ? `on a TV this would have burst ${CLEAR_KEY_PAIRS * 2} delete keys at the ` +
                "focus engine"
              : "a named key is navigation on a TV, which `tv-remote` owns, so this press would " +
                "have gone to the focus engine") +
            ". The probe " +
            "reads `pm list features` and `ro.build.characteristics`; a device still booting, or one " +
            "under enough load to miss the 5s budget, answers neither. Check `list-devices` reports " +
            "it in the `device` state and retry — or, if it IS a TV, drive the field with `tv-remote` " +
            "and the app's own on-screen keyboard.",
          {
            error_code: FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN,
            failure_stage: "keyboard_android_runtime_kind",
            failure_area: "tool_server",
            error_kind: "timeout",
            failure_command: "adb",
          }
        );
      }
      return typeAndroidPhone(device, params, options?.signal);
    },
  };
}
