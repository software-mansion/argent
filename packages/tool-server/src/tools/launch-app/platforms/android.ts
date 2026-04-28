import type { LaunchAppParams, LaunchAppResult } from "./ios";

/**
 * Android launch path (when implemented):
 *   `adb shell am start -W -n <pkg>/<.Activity>`
 * Use `cmd package resolve-activity --brief <pkg>` to find the LAUNCHER
 * activity if no explicit one is provided.
 *
 * Note: when wiring this up, also make `launch-app/index.ts` services()
 * platform-aware — Android doesn't need the iOS native-devtools service.
 */
export async function launchAppAndroid(
  _services: unknown,
  _params: LaunchAppParams
): Promise<LaunchAppResult> {
  throw new Error("launch-app on Android is not yet implemented (use `adb shell am start`).");
}
