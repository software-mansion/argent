import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { deviceIdOwningUrn, transportNamespacesForPlatform } from "./device-services";

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
    interaction: {
      startedMsg: ({ params }) => `Stopping simulator server for ${params.udid}`,
      completedMsg: ({ params }) => `Stopped simulator server for ${params.udid}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to stop simulator server for ${params.udid}: ${failureSignal.error_code}`,
    },
    description: `Stop the transport session for a specific device (iOS / Android: simulator-server process; Chromium: CDP WebSocket) and free its resources; on a TV target it also reaps that device's TV-control daemons. Use when you are done interacting with one device but want to keep others running, or to restart a wedged transport. On iOS / Android / TV it deliberately leaves this device's native-devtools, accessibility, profiler and debugger services running - to drain those as well, use stop-all-simulator-servers with \`devices\`. On CHROMIUM that does not hold: the JS-runtime debugger declares the CDP session as a dependency, so stopping the transport cascades to it and its captured console history goes with it - reconnect with debugger-connect afterwards. Returns { stopped, udid }. Fails silently if no session is open for the given id.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const udid = (params as { udid: string }).udid;
      // A device id can back more than one service: the transport
      // (SimulatorServer / ChromiumCdp) and, on a TV target, the TvControl
      // daemon owning the spawned tvos-ax/tvos-hid processes. See
      // `transportNamespacesForPlatform` for why the set stops there rather than
      // draining everything this device owns.
      const platform = resolveDevice(udid).platform;
      const namespaces = transportNamespacesForPlatform(platform);

      const snapshot = registry.getSnapshot();
      let stopped = false;
      // Scanned rather than fetched by exact URN, so ids resolve through the
      // same case-insensitive matcher as `stop-all-simulator-servers`;
      // `services.get()` would silently no-op on a mis-cased UDID.
      const urns = [...snapshot.services.keys()].filter(
        (urn) => deviceIdOwningUrn(urn, namespaces, [udid]) !== undefined
      );
      for (const urn of urns) {
        const entry = snapshot.services.get(urn);
        if (!entry || entry.state === ServiceState.IDLE) continue;
        // ERROR / TERMINATING nodes hold no process — e.g. a tvOS UDID, which
        // the SimulatorServer factory rejects on start. Clean it up, but don't
        // report it as stopped.
        if (isLiveServiceState(entry.state)) stopped = true;
        await registry.disposeService(urn);
      }
      return { stopped, udid };
    },
  };
}
