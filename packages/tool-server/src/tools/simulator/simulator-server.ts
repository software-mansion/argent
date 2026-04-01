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
  description: `Start (or connect to) the simulator-server process for a given simulator UDID and return its API URL.
Use when explicitly setting up a simulator session before interaction; during normal interaction tasks all tools start the server automatically — only call this tool for diagnostic or setup purposes.

Parameters: udid — the simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns { udid, apiUrl } (e.g. { "apiUrl": "http://127.0.0.1:4200" }). Fails if the simulator is not booted — call boot-simulator first.`,
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
