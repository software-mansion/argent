import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../blueprints/physical-ios-automation";
import { isPhysicalIos, resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  orientation: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const rotateTool: ToolDefinition<Params, Result> = {
  id: "rotate",
  description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown.
Use to test layout in a different orientation. Re-run \`describe\` afterwards — frame coordinates change with the orientation.
Returns { orientation }. Fails if the target device is not booted.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return isPhysicalIos(device)
      ? { physicalIos: physicalIosAutomationRef(device) }
      : { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    if (isPhysicalIos(resolveDevice(params.udid))) {
      await (services.physicalIos as PhysicalIosAutomationApi).rotate(params.orientation);
      return { orientation: params.orientation };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, { cmd: "rotate", direction: params.orientation });
    return { orientation: params.orientation };
  },
};
