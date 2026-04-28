import type { GestureRotateParams, GestureRotateResult, GestureRotateServices } from "./ios";

export async function rotateGestureAndroid(
  _services: GestureRotateServices,
  _params: GestureRotateParams
): Promise<GestureRotateResult> {
  // Same multi-touch limitation as gesture-pinch — adb sendevent does not
  // support second-touch coordinates. UiAutomator instrumentation is the
  // future path.
  throw new Error(
    "gesture-rotate on Android is not yet implemented (requires multi-touch instrumentation backend)."
  );
}
