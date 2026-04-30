import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureSwipeParams, GestureSwipeResult, GestureSwipeServices } from "./ios";

export const androidImpl: PlatformImpl<
  GestureSwipeServices,
  GestureSwipeParams,
  GestureSwipeResult
> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "gesture-swipe",
      platform: "android",
      hint:
        "Use `adb shell input swipe <x1> <y1> <x2> <y2> <durationMs>` (coordinates " +
        "in device pixels — convert from normalized via `adb shell wm size`).",
    });
  },
};
