import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "./ios";

/**
 * Android reinstall path (when implemented):
 *   `adb -s <serial> install -r [-d] [-g] <path/to/app.apk>`
 *   -r: reinstall, keep data; -d: allow downgrade; -g: grant runtime perms.
 */
export async function reinstallAppAndroid(
  _services: ReinstallAppServices,
  _params: ReinstallAppParams
): Promise<ReinstallAppResult> {
  throw new Error("reinstall-app on Android is not yet implemented (use `adb install -r`).");
}
