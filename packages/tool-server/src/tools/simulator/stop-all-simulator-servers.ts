import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";

const PREFIXES = [`${SIMULATOR_SERVER_NAMESPACE}:`, `${NATIVE_DEVTOOLS_NAMESPACE}:`];

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<void, { stopped: string[] }> {
  return {
    id: "stop-all-simulator-servers",
    description: `Stop all running simulator-server processes and native devtools services and free their resources.
Use when the session ends, the user says they are done, or before a fresh setup to ensure no stale servers are running.

Parameters: none — this tool takes no parameters (udid is not needed; all active servers are stopped regardless of UDID).
Example: {}
Returns { stopped: [...urns] } listing all server URNs that were shut down (e.g. ["SimulatorServer:A1B2C3D4-E5F6-7890-ABCD-EF1234567890"]). If no servers are running returns { stopped: [] }. Never fails even if no servers were active.`,
    services: () => ({}),
    async execute() {
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      for (const [urn, entry] of snapshot.services) {
        if (PREFIXES.some((p) => urn.startsWith(p)) && entry.state !== ServiceState.IDLE) {
          await registry.disposeService(urn);
          stopped.push(urn);
        }
      }
      return { stopped };
    },
  };
}
