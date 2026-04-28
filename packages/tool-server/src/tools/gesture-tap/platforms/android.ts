import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureTapParams, GestureTapResult, GestureTapServices } from "./ios";

export const androidImpl: PlatformImpl<GestureTapServices, GestureTapParams, GestureTapResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "gesture-tap",
      platform: "android",
      hint:
        "Use `adb shell input tap <x> <y>` (device pixels — convert from " +
        "normalized via `adb shell wm size`).",
    });
  },
};
