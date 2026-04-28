import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureCustomParams, GestureCustomResult, GestureCustomServices } from "./ios";

export const androidImpl: PlatformImpl<
  GestureCustomServices,
  GestureCustomParams,
  GestureCustomResult
> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "gesture-custom",
      platform: "android",
      hint:
        "Single-touch sequences map to `adb shell sendevent` events. Multi-touch (x2, y2) " +
        "requires UiAutomator instrumentation — adb sendevent does not expose a second " +
        "touch slot. Convert normalized coordinates to device pixels via `adb shell wm size`.",
    });
  },
};
