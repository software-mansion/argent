import { z } from "zod";
import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id (iOS UDID, Android serial, or Chromium id) whose transport session to stop"
    ),
});

export function createStopSimulatorServerTool(
  registry: Registry
): ToolDefinition<{ udid: string }, { stopped: boolean; udid: string }> {
  return {
    id: "stop-simulator-server",
    description: `Stop the transport session for a specific device (iOS / Android: simulator-server process; Chromium: CDP WebSocket) and free its resources. Use when you are done interacting with one device but want to keep others running. Returns { stopped, udid }. Fails silently if no session is open for the given id.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const udid = (params as { udid: string }).udid;
      const namespace =
        resolveDevice(udid).platform === "chromium"
          ? CHROMIUM_CDP_NAMESPACE
          : SIMULATOR_SERVER_NAMESPACE;
      const urn = `${namespace}:${udid}`;
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
