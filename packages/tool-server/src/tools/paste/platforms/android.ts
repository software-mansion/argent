import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { PasteParams, PasteResult, PasteServices } from "./ios";

export const androidImpl: PlatformImpl<PasteServices, PasteParams, PasteResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "paste",
      platform: "android",
      hint:
        'Use `adb shell input text "<text>"` for direct text injection, or write to ' +
        "the clipboard via `cmd clipboard` and dispatch KEYCODE_PASTE (279) into the " +
        "focused field.",
    });
  },
};
