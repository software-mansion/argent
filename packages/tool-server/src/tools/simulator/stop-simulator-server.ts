import { z } from "zod";
import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator whose server to stop"),
});

export function createStopSimulatorServerTool(
  registry: Registry
): ToolDefinition<{ udid: string }, { stopped: boolean; udid: string }> {
  return {
    id: "stop-simulator-server",
    description: `Stop the simulator-server process for a specific simulator UDID and free its resources.
Use when you are done interacting with a particular simulator but want to leave other simulator servers running. To stop all servers at once use stop-all-simulator-servers.

Parameters: udid — the UDID of the simulator whose server should be stopped (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns { stopped: true, udid } if a server was running and was shut down; { stopped: false, udid } if no server was active for that UDID. Does not fail if the server was never started.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const udid = (params as { udid: string }).udid;
      const urn = `${SIMULATOR_SERVER_NAMESPACE}:${udid}`;
      const snapshot = registry.getSnapshot();
      const entry = snapshot.services.get(urn);
      if (!entry || entry.state === ServiceState.IDLE) {
        return { stopped: false, udid };
      }
      await registry.disposeService(urn);
      return { stopped: true, udid };
    },
  };
}
