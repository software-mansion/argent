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
  description: `Get (or start) the simulator-server for a given udid — SETUP ONLY.
Use when you need to verify the server is running or retrieve its apiUrl (e.g. "http://127.0.0.1:PORT") before custom HTTP calls.
Do not call this during interaction tasks; tap, swipe, paste, screenshot, and all other tools start the server automatically.
Accepts: udid. Returns the apiUrl. Fails if the simulator is not booted or UDID is invalid.`,
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
