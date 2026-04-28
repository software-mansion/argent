import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "./ios";

export const androidImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "open-url",
      platform: "android",
      hint: 'Use `adb shell am start -a android.intent.action.VIEW -d "<url>"`.',
    });
  },
};
