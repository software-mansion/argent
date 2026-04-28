import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { GesturePinchParams, GesturePinchResult, GesturePinchServices } from "./ios";

export async function pinchAndroid(
  _services: GesturePinchServices,
  _params: GesturePinchParams
): Promise<GesturePinchResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "gesture-pinch",
    platform: "android",
    hint:
      "Multi-touch — adb sendevent does not expose second-touch coordinates. " +
      "Requires UiAutomator instrumentation (UiObject.pinchIn / pinchOut) or a " +
      "simulator-server-android backend.",
  });
}
