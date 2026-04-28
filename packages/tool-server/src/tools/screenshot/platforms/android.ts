import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ScreenshotParams, ScreenshotResult, ScreenshotServices } from "./ios";

export const androidImpl: PlatformImpl<ScreenshotServices, ScreenshotParams, ScreenshotResult> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "screenshot",
      platform: "android",
      hint:
        "Use `adb -s <serial> exec-out screencap -p` to get raw PNG bytes; save to " +
        "/tmp and return { url, path }. Apply scale/rotation client-side after capture.",
    });
  },
};
