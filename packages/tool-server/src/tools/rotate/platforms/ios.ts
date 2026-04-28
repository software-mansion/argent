import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";

export type Orientation =
  | "Portrait"
  | "LandscapeLeft"
  | "LandscapeRight"
  | "PortraitUpsideDown";

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

export async function rotateIos(
  services: RotateServices,
  params: RotateParams
): Promise<RotateResult> {
  const api = services.simulatorServer;
  sendCommand(api, { cmd: "rotate", direction: params.orientation });
  return { orientation: params.orientation };
}
