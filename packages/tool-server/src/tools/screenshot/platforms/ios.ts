import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { httpScreenshot } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

export interface ScreenshotParams {
  udid: string;
  rotation?: "Portrait" | "LandscapeLeft" | "LandscapeRight" | "PortraitUpsideDown";
  scale?: number;
}

export interface ScreenshotResult {
  url: string;
  path: string;
}

export interface ScreenshotServices {
  simulatorServer: SimulatorServerApi;
}

export const iosImpl: PlatformImpl<ScreenshotServices, ScreenshotParams, ScreenshotResult> = {
  handler: async (services, params, _device, options) => {
    const api = services.simulatorServer;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    return httpScreenshot(api, params.rotation, signal, params.scale);
  },
};
