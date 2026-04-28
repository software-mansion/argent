import type { RestartAppParams, RestartAppResult } from "./ios";

/**
 * Android restart path (when implemented):
 *   `adb shell am force-stop <pkg>` then `adb shell am start -W -n <pkg>/<.Activity>`.
 */
export async function restartAppAndroid(
  _services: unknown,
  _params: RestartAppParams
): Promise<RestartAppResult> {
  throw new Error(
    "restart-app on Android is not yet implemented (use `adb shell am force-stop` + `am start`)."
  );
}
