import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureRotateParams, GestureRotateResult, GestureRotateServices } from "./ios";

export const androidImpl: PlatformImpl<
  GestureRotateServices,
  GestureRotateParams,
  GestureRotateResult
> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "gesture-rotate",
      platform: "android",
      hint:
        "Multi-touch — same constraint as gesture-pinch. Requires UiAutomator " +
        "instrumentation; adb sendevent does not support second-touch coordinates.",
    });
  },
};
