import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { sendCommand } from "../../../utils/simulator-client";
import type { RotateParams, RotateResult, RotateServices } from "./ios";

// Android rotate goes through the same `simulator-server` channel as iOS:
// `simulator-server android --id <serial>` accepts the same `{cmd:"rotate"}`
// payload and drives the gRPC EmulatorController. No `adb` shell-out needed,
// so this branch declares no `requires`.
export const androidImpl: PlatformImpl<RotateServices, RotateParams, RotateResult> = {
  handler: async (services, params) => {
    sendCommand(services.simulatorServer, { cmd: "rotate", direction: params.orientation });
    return { orientation: params.orientation };
  },
};
