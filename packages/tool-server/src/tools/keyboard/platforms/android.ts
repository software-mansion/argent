import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { KeyboardParams, KeyboardResult, KeyboardServices } from "./ios";

export const androidImpl: PlatformImpl<KeyboardServices, KeyboardParams, KeyboardResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "keyboard",
      platform: "android",
      hint:
        'Use `adb shell input text "..."` for character streams and `adb shell input ' +
        "keyevent <KEYCODE_*>` for named keys (enter=66, escape=111, backspace=67, " +
        "tab=61, arrow-up=19, arrow-down=20, arrow-left=21, arrow-right=22).",
    });
  },
};
