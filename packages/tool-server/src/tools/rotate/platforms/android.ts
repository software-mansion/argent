import type { RotateParams, RotateResult, RotateServices } from "./ios";

/**
 * Android rotation path (when implemented):
 *   `adb shell settings put system user_rotation <0|1|2|3>` plus
 *   `adb shell content insert --uri content://settings/system --bind name:s:user_rotation_required:b:true`
 * or via the emulator console for AVDs.
 */
export async function rotateAndroid(
  _services: RotateServices,
  _params: RotateParams
): Promise<RotateResult> {
  throw new Error(
    "rotate on Android is not yet implemented (use `adb shell settings put system user_rotation`)."
  );
}
