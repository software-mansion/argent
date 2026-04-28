import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureTapParams, GestureTapResult, GestureTapServices } from "./ios";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const androidImpl: PlatformImpl<GestureTapServices, GestureTapParams, GestureTapResult> = {
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
