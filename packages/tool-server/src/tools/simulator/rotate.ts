import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

export const rotateTool: ToolDefinition<z.infer<typeof zodSchema>, { orientation: string }> = {
  id: "rotate",
  description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown.
Use to test layout in a different orientation. Re-run \`describe\` afterwards — frame coordinates change with the orientation.
Returns { orientation }. Fails if the target device is not booted.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: `SimulatorServer:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, { cmd: "rotate", direction: params.orientation });
    return { orientation: params.orientation };
  },
};
