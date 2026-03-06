import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  button: z
    .enum([
      "home",
      "back",
      "power",
      "volumeUp",
      "volumeDown",
      "appSwitch",
      "actionButton",
    ])
    .describe("Hardware button to press"),
});

export const buttonTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { pressed: string }
> = {
  id: "button",
  description: `Press a simulator hardware button. Sends Down then Up events automatically.
Supported buttons: home, back, power, volumeUp, volumeDown, appSwitch, actionButton.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, { cmd: "button", direction: "Down", button: params.button });
    await sleep(50);
    sendCommand(api, { cmd: "button", direction: "Up", button: params.button });
    return { pressed: params.button };
  },
};
