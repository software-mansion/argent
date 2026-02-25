import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to connect to"),
  token: z
    .string()
    .optional()
    .describe("JWT license token for Pro features"),
});

export const simulatorServerTool: ToolDefinition<{
  udid: string;
  token?: string;
}> = {
  id: "simulator-server",
  description:
    "Launch (or reuse) the simulator-server process for a given simulator UDID and return its API and stream URLs",
  zodSchema,
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
      options: { token: params.token },
    },
  }),
  async execute(services, params, _options) {
    const api = services.simulatorServer as SimulatorServerApi;
    return {
      udid: params.udid,
      apiUrl: api.apiUrl,
      streamUrl: api.streamUrl,
    };
  },
};
