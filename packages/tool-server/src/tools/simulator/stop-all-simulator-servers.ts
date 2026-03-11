import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";

const PREFIX = `${SIMULATOR_SERVER_NAMESPACE}:`;

export function createStopAllSimulatorServersTool(
  registry: Registry,
): ToolDefinition<void, { stopped: string[] }> {
  return {
    id: "stop-all-simulator-servers",
    description:
      "Stop all running simulator-server processes. " +
      "Call this when your session ends or the user says they are done, to free resources.",
    services: () => ({}),
    async execute() {
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      for (const [urn, entry] of snapshot.services) {
        if (urn.startsWith(PREFIX) && entry.state !== ServiceState.IDLE) {
          await registry.disposeService(urn);
          stopped.push(urn);
        }
      }
      return { stopped };
    },
  };
}
