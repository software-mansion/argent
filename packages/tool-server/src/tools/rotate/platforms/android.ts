import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { sendCommand } from "../../../utils/simulator-client";
import type { RotateParams, RotateResult, RotateServices } from "./ios";

export const androidImpl: PlatformImpl<RotateServices, RotateParams, RotateResult> = {
  handler: async (services, params) => {
    sendCommand(services.simulatorServer, { cmd: "rotate", direction: params.orientation });
    return { orientation: params.orientation };
  },
};
