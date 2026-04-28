import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ButtonParams, ButtonResult, ButtonServices } from "./ios";

export const androidImpl: PlatformImpl<ButtonServices, ButtonParams, ButtonResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "button",
      platform: "android",
      hint: "Use `adb shell input keyevent <KEYCODE>`: home=3, back=4, appSwitch=187, volumeUp=24, volumeDown=25, power=26.",
    });
  },
};
