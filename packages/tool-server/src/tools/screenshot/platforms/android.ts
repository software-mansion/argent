import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { ScreenshotParams, ScreenshotResult, ScreenshotServices } from "./ios";

export async function screenshotAndroid(
  _services: ScreenshotServices,
  _params: ScreenshotParams,
  _signal: AbortSignal
): Promise<ScreenshotResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "screenshot",
    platform: "android",
    hint:
      "Use `adb -s <serial> exec-out screencap -p` to get raw PNG bytes; save to " +
      "/tmp and return { url, path }. Apply scale/rotation client-side after capture.",
  });
}
