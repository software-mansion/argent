import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";

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

export async function tapIos(
  services: GestureTapServices,
  params: GestureTapParams
): Promise<GestureTapResult> {
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
}
