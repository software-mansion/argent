import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GestureTapParams {
  udid: string;
  x: number;
  y: number;
}

export interface GestureTapResult {
  tapped: boolean;
  timestampMs: number;
}

export interface GestureTapServices {
  simulatorServer: SimulatorServerApi;
}

// iOS gesture-tap goes through the bundled simulator-server binary, not xcrun
// directly — leave `requires` empty here. xcrun is only declared on tools that
// shell out to it themselves (launch-app, restart-app, reinstall-app, open-url).
export const iosImpl: PlatformImpl<GestureTapServices, GestureTapParams, GestureTapResult> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    const timestampMs = Date.now();
    sendCommand(api, {
      cmd: "touch",
      type: "Down",
      x: params.x,
      y: params.y,
      second_x: null,
      second_y: null,
    });
    await sleep(50);
    sendCommand(api, {
      cmd: "touch",
      type: "Up",
      x: params.x,
      y: params.y,
      second_x: null,
      second_y: null,
    });
    return { tapped: true, timestampMs };
  },
};
