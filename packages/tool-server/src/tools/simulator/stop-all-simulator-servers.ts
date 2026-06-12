import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { disposeAllVegaAgents } from "../../utils/vega-agent-manager";

const PREFIXES = [
  `${SIMULATOR_SERVER_NAMESPACE}:`,
  `${NATIVE_DEVTOOLS_NAMESPACE}:`,
  `${ANDROID_DEVTOOLS_NAMESPACE}:`,
  `${CHROMIUM_CDP_NAMESPACE}:`,
];

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<void, { stopped: string[] }> {
  return {
    id: "stop-all-simulator-servers",
    description: `Stop all running simulator-server processes (iOS + Android), native devtools services, Chromium CDP sessions, and Vega on-device agents, freeing their resources. Call this when your session ends or the user says they are done. Returns { stopped } — an array of URNs/identifiers that were shut down. Fails silently if no servers are running.`,
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
      // On-device Vega agents are managed outside the registry (see
      // vega-agent-manager); shut them down + drop their adb forwards too.
      for (const udid of await disposeAllVegaAgents()) {
        stopped.push(`VegaAgent:${udid}`);
      }
      return { stopped };
    },
  };
}
