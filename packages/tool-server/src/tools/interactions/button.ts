import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().min(1).describe("Simulator UDID"),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

export const buttonTool: ToolDefinition<z.infer<typeof zodSchema>, { pressed: string }> = {
  id: "button",
  requires: ["xcrun"],
  description: `Press a simulator hardware button. Sends Down then Up events automatically.
Supported buttons: home, back, power, volumeUp, volumeDown, appSwitch, actionButton.
Use when you need to trigger a hardware button events.
Returns { pressed: buttonName }.
Fails if the simulator server is not running for the given UDID.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, {
      cmd: "button",
      direction: "Down",
      button: params.button,
    });
    await sleep(50);
    sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
    return { pressed: params.button };
  },
};
