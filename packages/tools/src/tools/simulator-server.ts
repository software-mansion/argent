import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to connect to"),
  token: z
    .string()
    .optional()
    .describe("JWT license token for Pro features (screenshot, recording)"),
});

export const simulatorServerTool: ToolDefinition<
  { udid: string; token?: string },
  { udid: string; apiUrl: string; streamUrl: string }
> = {
  id: "simulator-server",
  description: `SETUP ONLY — Get (or start) the simulator-server for a UDID.
Do not call this during interaction tasks; tap, swipe, paste, screenshot, and all other tools start the server automatically.
Use this only to explicitly pass a JWT token for Pro features (screenshot, recording) before running those tools.
Returns { apiUrl, streamUrl }.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
      options: { token: params.token },
    },
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    return {
      udid: params.udid,
      apiUrl: api.apiUrl,
      streamUrl: api.streamUrl,
    };
  },
};
