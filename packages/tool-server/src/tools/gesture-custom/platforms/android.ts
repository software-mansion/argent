import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { GestureCustomParams, GestureCustomResult, GestureCustomServices } from "./ios";

export async function customAndroid(
  _services: GestureCustomServices,
  _params: GestureCustomParams
): Promise<GestureCustomResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "gesture-custom",
    platform: "android",
    hint:
      "Single-touch sequences map to `adb shell sendevent` events. Multi-touch (x2, y2) " +
      "requires UiAutomator instrumentation — adb sendevent does not expose a second " +
      "touch slot. Convert normalized coordinates to device pixels via `adb shell wm size`.",
  });
}
