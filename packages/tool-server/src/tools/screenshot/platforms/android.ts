import { httpScreenshot } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ScreenshotParams, ScreenshotResult, ScreenshotServices } from "./ios";

export const androidImpl: PlatformImpl<ScreenshotServices, ScreenshotParams, ScreenshotResult> = {
  handler: async (services, params, _device, options) => {
    const api = services.simulatorServer;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal, params.scale);
  },
};
