import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

export const rotateTool: ToolDefinition<z.infer<typeof zodSchema>, { orientation: string }> = {
  id: "rotate",
  description: `Set the simulator screen to the specified orientation.
Use when testing landscape layouts, responsive UI, or reproducing orientation-specific bugs.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); orientation — one of Portrait, LandscapeLeft, LandscapeRight, PortraitUpsideDown.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "orientation": "LandscapeLeft" }
Returns { orientation } confirming the new orientation. Requires a running simulator-server (started automatically). Fails if the simulator is not booted.`,
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
