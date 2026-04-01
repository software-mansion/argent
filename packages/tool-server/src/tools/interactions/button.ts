import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

export const buttonTool: ToolDefinition<z.infer<typeof zodSchema>, { pressed: string }> = {
  id: "button",
  description: `Press a simulator hardware button (Down then Up events are sent automatically).
Use when pressing the Home button to dismiss an app, locking the screen with power, adjusting volume, or simulating device-level actions not reachable through the app UI.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); button — one of home, back, power, volumeUp, volumeDown, appSwitch, actionButton.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "button": "home" }
Returns { pressed: "<button name>" }. Fails if the simulator-server cannot start or the simulator is not booted.`,
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
