import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "./ios";

/**
 * Android open-url path (when implemented):
 *   `adb shell am start -a android.intent.action.VIEW -d "<url>"`
 */
export async function openUrlAndroid(
  _services: OpenUrlServices,
  _params: OpenUrlParams
): Promise<OpenUrlResult> {
  throw new Error(
    "open-url on Android is not yet implemented (use `adb shell am start -a android.intent.action.VIEW`)."
  );
}
