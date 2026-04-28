import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ButtonName =
  | "home"
  | "back"
  | "power"
  | "volumeUp"
  | "volumeDown"
  | "appSwitch"
  | "actionButton";

export interface ButtonParams {
  udid: string;
  button: ButtonName;
}

export interface ButtonResult {
  pressed: string;
}

export interface ButtonServices {
  simulatorServer: SimulatorServerApi;
}

export async function buttonIos(
  services: ButtonServices,
  params: ButtonParams
): Promise<ButtonResult> {
  const api = services.simulatorServer;
  sendCommand(api, {
    cmd: "button",
    direction: "Down",
    button: params.button,
  });
  await sleep(50);
  sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
  return { pressed: params.button };
}
