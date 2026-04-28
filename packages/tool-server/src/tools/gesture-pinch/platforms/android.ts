import type { GesturePinchParams, GesturePinchResult, GesturePinchServices } from "./ios";

export async function pinchAndroid(
  _services: GesturePinchServices,
  _params: GesturePinchParams
): Promise<GesturePinchResult> {
  // Android adb does not expose a multi-touch API; pinch requires an
  // instrumentation-based backend (UiAutomator pinchIn/pinchOut). When that
  // backend lands, replace this stub and add `android` to capability.
  throw new Error(
    "gesture-pinch on Android is not yet implemented (requires instrumentation-based backend; " +
      "adb sendevent does not support multi-touch). Wire UiAutomator pinch here."
  );
}
