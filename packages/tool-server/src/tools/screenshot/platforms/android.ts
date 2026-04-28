import { httpScreenshot } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ScreenshotParams, ScreenshotResult, ScreenshotServices } from "./ios";

// Android uses the same `simulator-server` channel as iOS — see comment in
// `gesture-tap/platforms/android.ts` for context. The HTTP screenshot endpoint
// on `simulator-server android` returns a PNG over the same protocol.
export const androidImpl: PlatformImpl<ScreenshotServices, ScreenshotParams, ScreenshotResult> = {
  handler: async (services, params, _device, options) => {
    const api = services.simulatorServer;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal, params.scale);
  },
};
