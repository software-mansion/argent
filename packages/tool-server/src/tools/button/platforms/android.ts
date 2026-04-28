import type { ButtonParams, ButtonResult, ButtonServices } from "./ios";

export async function buttonAndroid(
  _services: ButtonServices,
  _params: ButtonParams
): Promise<ButtonResult> {
  // Android equivalents: home/back/appSwitch via `adb shell input keyevent`,
  // power/volume via the same. Wire those here when implementing Android.
  throw new Error("button on Android is not yet implemented (use `adb shell input keyevent`).");
}
