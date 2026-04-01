import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { SimulatorServerApi } from "../../blueprints/simulator-server";

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to connect to"),
});

export const simulatorServerTool: ToolDefinition<
  { udid: string },
  { udid: string; apiUrl: string }
> = {
  id: "simulator-server",
  description: `Start (or get) the simulator-server process for a UDID and return its API URL.
Use when you need the server URL before interaction tools auto-start it. Returns { udid, apiUrl }. Fails if the simulator is not booted or the UDID is invalid.`,
  zodSchema,
  services: (params) => ({
    simulatorServer: {
      urn: `SimulatorServer:${params.udid}`,
    },
  }),
  async execute(services, params) {
    const api = services.simulatorServer as SimulatorServerApi;
    return {
      udid: params.udid,
      apiUrl: api.apiUrl,
    };
  },
};
