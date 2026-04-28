import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type ButtonResult, type ButtonServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  button: z
    .enum(["home", "back", "power", "volumeUp", "volumeDown", "appSwitch", "actionButton"])
    .describe("Hardware button to press"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const buttonTool: ToolDefinition<Params, ButtonResult> = {
  id: "button",
  description: `Press a simulator hardware button. Sends Down then Up events automatically.
Supported buttons: home, back, power, volumeUp, volumeDown, appSwitch, actionButton.
Use when you need to trigger a hardware button events.
Returns { pressed: buttonName }.
Fails if the simulator server is not running for the given UDID.`,
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  execute: dispatchByPlatform<ButtonServices, Params, ButtonResult>({
    toolId: "button",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
