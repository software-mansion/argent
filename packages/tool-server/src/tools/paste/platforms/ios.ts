import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sendCommand } from "../../../utils/simulator-client";

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

export async function pasteIos(
  services: PasteServices,
  params: PasteParams
): Promise<PasteResult> {
  const api = services.simulatorServer;
  sendCommand(api, { cmd: "paste", text: params.text });
  return { pasted: true };
}
