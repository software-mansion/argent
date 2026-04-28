import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GesturePinchParams, GesturePinchResult, GesturePinchServices } from "./ios";

export const androidImpl: PlatformImpl<
  GesturePinchServices,
  GesturePinchParams,
  GesturePinchResult
> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "gesture-pinch",
      platform: "android",
      hint:
        "Multi-touch — adb sendevent does not expose second-touch coordinates. " +
        "Requires UiAutomator instrumentation (UiObject.pinchIn / pinchOut) or a " +
        "simulator-server-android backend.",
    });
  },
};
