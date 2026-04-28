import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { GestureTapParams, GestureTapResult, GestureTapServices } from "./ios";

export async function tapAndroid(
  _services: GestureTapServices,
  _params: GestureTapParams
): Promise<GestureTapResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "gesture-tap",
    platform: "android",
    hint:
      "Use `adb shell input tap <x> <y>` (device pixels — convert from " +
      "normalized via `adb shell wm size`).",
  });
}
