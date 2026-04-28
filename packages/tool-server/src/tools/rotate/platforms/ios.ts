import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

export type Orientation = "Portrait" | "LandscapeLeft" | "LandscapeRight" | "PortraitUpsideDown";

export interface RotateParams {
  udid: string;
  orientation: Orientation;
}

export interface RotateResult {
  orientation: string;
}

export interface RotateServices {
  simulatorServer: SimulatorServerApi;
}

export const iosImpl: PlatformImpl<RotateServices, RotateParams, RotateResult> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    sendCommand(api, { cmd: "rotate", direction: params.orientation });
    return { orientation: params.orientation };
  },
};
