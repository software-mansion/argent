import type { GestureCustomParams, GestureCustomResult, GestureCustomServices } from "./ios";

export async function customAndroid(
  _services: GestureCustomServices,
  _params: GestureCustomParams
): Promise<GestureCustomResult> {
  throw new Error(
    "gesture-custom on Android is not yet implemented. Wire the adb / simulator-server-android " +
      "dispatch here, then add the android block to the tool's capability declaration."
  );
}
