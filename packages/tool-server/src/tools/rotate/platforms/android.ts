import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RotateParams, RotateResult, RotateServices } from "./ios";

export const androidImpl: PlatformImpl<RotateServices, RotateParams, RotateResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "rotate",
      platform: "android",
      hint:
        "Use `adb shell settings put system user_rotation <0|1|2|3>` " +
        "(0=Portrait, 1=LandscapeLeft, 2=PortraitUpsideDown, 3=LandscapeRight). " +
        "May also need `accelerometer_rotation=0` to lock orientation.",
    });
  },
};
