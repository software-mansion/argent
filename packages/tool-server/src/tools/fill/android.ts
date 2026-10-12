import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import { noFocusedFieldError, notVerifiedError } from "./errors";
import { fillByAndroidKeys, typeableOnAndroid } from "./keys";
import type { FillResult } from "./types";

/**
 * Android phone or tablet. The devtools helper finds the input-focused node,
 * sets its text with ACTION_SET_TEXT and reads it back (a password by length),
 * answering only whether it matched.
 *
 * - A helper older than `setText`, or one that cannot start, falls back to
 *   keys, unverified.
 * - A write that does not read back is retried with keys and read back again.
 */
export async function fillAndroid(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  let helper: AndroidDevtoolsApi | null = null;
  try {
    const ref = androidDevtoolsRef(device);
    helper = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch {
    // The helper could not be installed or started; keys need only adb.
  }
  const first = helper ? await helper.setText(text) : null;
  if (!helper || first === null) {
    await fillByAndroidKeys(device.id, text);
    return { method: "keys", verified: null };
  }
  if (!first.focused) throw noFocusedFieldError("fill_android_no_focus");
  if (first.verified) return { method: "helper", verified: true, length: first.length };

  if (!typeableOnAndroid(text)) throw notVerifiedError("helper", "fill_android_not_verified");
  await fillByAndroidKeys(device.id, text);
  const check = await helper.setText(text, { check: true });
  if (check?.verified) return { method: "keys", verified: true, length: check.length };
  throw notVerifiedError("keys", "fill_android_not_verified");
}
