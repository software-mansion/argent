import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

export interface PasteParams {
  udid: string;
  text: string;
}

export interface PasteResult {
  pasted: boolean;
}

export interface PasteServices {
  simulatorServer: SimulatorServerApi;
}

export const iosImpl: PlatformImpl<PasteServices, PasteParams, PasteResult> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    sendCommand(api, { cmd: "paste", text: params.text });
    return { pasted: true };
  },
};
