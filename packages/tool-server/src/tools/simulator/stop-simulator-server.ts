import { z } from "zod";
import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id (iOS UDID or Android serial) whose simulator-server to stop"),
});

export function createStopSimulatorServerTool(
  registry: Registry
): ToolDefinition<{ udid: string }, { stopped: boolean; udid: string }> {
  return {
    id: "stop-simulator-server",
    description: `Stop the simulator-server process for a specific device (iOS UDID or Android serial) and free its resources. Use when you are done interacting with one device but want to keep others running. Returns { stopped, udid }. Fails silently if no server is running for the given UDID.`,
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
