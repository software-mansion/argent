import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { ButtonParams, ButtonResult, ButtonServices } from "./ios";

export async function buttonAndroid(
  _services: ButtonServices,
  _params: ButtonParams
): Promise<ButtonResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "button",
    platform: "android",
    hint: "Use `adb shell input keyevent <KEYCODE>`: home=3, back=4, appSwitch=187, volumeUp=24, volumeDown=25, power=26.",
  });
}
