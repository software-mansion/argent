import type { GestureSwipeParams, GestureSwipeResult, GestureSwipeServices } from "./ios";

export async function swipeAndroid(
  _services: GestureSwipeServices,
  _params: GestureSwipeParams
): Promise<GestureSwipeResult> {
  throw new Error(
    "gesture-swipe on Android is not yet implemented. Wire the adb / simulator-server-android " +
      "dispatch here, then add the android block to the tool's capability declaration."
  );
}
