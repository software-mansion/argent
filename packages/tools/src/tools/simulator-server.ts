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
  description: `Get (or start) the simulator-server for a UDID.
Returns { apiUrl, streamUrl }. If no server is running for this UDID, one is started automatically.
Use this explicitly to pass a JWT token for Pro features (screenshot, recording).
All other tools also trigger auto-start without a token if needed.`,
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
