import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. iOS: simulator UDID (UUID shape). Android: adb serial (e.g. `emulator-5554`)."
    ),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

export const buttonTool: ToolDefinition<z.infer<typeof zodSchema>, { pressed: string }> = {
  id: "button",
  description: `Press a hardware button on iOS or Android. Sends Down then Up events automatically.
Supported: home, back, power, volumeUp, volumeDown, appSwitch, actionButton. The simulator-server binary maps these to each platform's native keycode internally.
Returns { pressed: buttonName }. Fails if the simulator server cannot start.`,
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
