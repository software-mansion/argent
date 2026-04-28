import type { GestureTapParams, GestureTapResult, GestureTapServices } from "./ios";

export async function tapAndroid(
  _services: GestureTapServices,
  _params: GestureTapParams
): Promise<GestureTapResult> {
  throw new Error(
    "gesture-tap on Android is not yet implemented. The cross-platform architecture " +
      "is in place — fill in the adb / simulator-server-android dispatch here, then " +
      "add `android: { emulator: true, device: true, unknown: true }` to the tool's " +
      "capability declaration."
  );
}
