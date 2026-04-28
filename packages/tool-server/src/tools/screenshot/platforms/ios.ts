import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { httpScreenshot } from "../../../utils/simulator-client";

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

export async function screenshotIos(
  services: ScreenshotServices,
  params: ScreenshotParams,
  signal: AbortSignal
): Promise<ScreenshotResult> {
  const api = services.simulatorServer;
  return httpScreenshot(api, params.rotation, signal, params.scale);
}
