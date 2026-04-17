import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. iOS: simulator UDID (UUID shape). Android: adb serial (e.g. `emulator-5554`)."
    ),
  orientation: z
    .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
    .describe("Target orientation"),
});

export const rotateTool: ToolDefinition<z.infer<typeof zodSchema>, { orientation: string }> = {
  id: "rotate",
  description: `Set the device orientation to Portrait, LandscapeLeft, LandscapeRight, or PortraitUpsideDown. Works on iOS and Android via simulator-server. Re-run \`describe\` afterwards — frame coordinates change. Returns { orientation }. Fails if the simulator server cannot start.`,
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
