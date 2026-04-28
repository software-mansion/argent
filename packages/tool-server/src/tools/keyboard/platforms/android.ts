import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { KeyboardParams, KeyboardResult, KeyboardServices } from "./ios";

export async function keyboardAndroid(
  _services: KeyboardServices,
  _params: KeyboardParams
): Promise<KeyboardResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "keyboard",
    platform: "android",
    hint:
      'Use `adb shell input text "..."` for character streams and `adb shell input ' +
      "keyevent <KEYCODE_*>` for named keys (enter=66, escape=111, backspace=67, " +
      "tab=61, arrow-up=19, arrow-down=20, arrow-left=21, arrow-right=22).",
  });
}
