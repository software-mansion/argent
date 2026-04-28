import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { GestureSwipeParams, GestureSwipeResult, GestureSwipeServices } from "./ios";

export async function swipeAndroid(
  _services: GestureSwipeServices,
  _params: GestureSwipeParams
): Promise<GestureSwipeResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "gesture-swipe",
    platform: "android",
    hint:
      "Use `adb shell input swipe <x1> <y1> <x2> <y2> <durationMs>` (coordinates " +
      "in device pixels — convert from normalized via `adb shell wm size`).",
  });
}
