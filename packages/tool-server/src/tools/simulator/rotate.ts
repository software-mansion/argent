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
  description: `Set the simulator orientation to a target value such as "LandscapeLeft" or "Portrait".
Use when you need to test layout in landscape mode, e.g. to verify responsive UI or reproduce a rotation bug.
Accepts: udid, orientation (one of Portrait, LandscapeLeft, LandscapeRight, PortraitUpsideDown). Returns the new orientation. Fails if the udid is invalid or the simulator-server is not running.`,
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
