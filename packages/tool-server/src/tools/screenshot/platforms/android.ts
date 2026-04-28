import type { ScreenshotParams, ScreenshotResult, ScreenshotServices } from "./ios";

export async function screenshotAndroid(
  _services: ScreenshotServices,
  _params: ScreenshotParams,
  _signal: AbortSignal
): Promise<ScreenshotResult> {
  throw new Error(
    "screenshot on Android is not yet implemented. Wire `adb exec-out screencap -p` here, " +
      "save the PNG to /tmp, and return { url, path }."
  );
}
