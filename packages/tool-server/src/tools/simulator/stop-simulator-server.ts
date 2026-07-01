import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";
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
      // A single device id can back more than one service: the transport
      // (SimulatorServer / ChromiumCdp) and — for a TV target — the focus-driven
      // TvControl daemon, which owns the spawned tvos-ax/tvos-hid processes. A
      // tvOS UDID is iOS-shaped, so we can't tell it apart from a phone here
      // without an async probe; instead, dispose every namespace this id could
      // own and report `stopped` if any of them was live. Shape narrows the set:
      // chromium ids only have a CDP session; everything else can be a simulator
      // server and/or a TV-control service.
      const platform = resolveDevice(udid).platform;
      const namespaces =
        platform === "chromium"
          ? [CHROMIUM_CDP_NAMESPACE]
          : platform === "android"
            ? [SIMULATOR_SERVER_NAMESPACE, ANDROID_TV_CONTROL_NAMESPACE]
            : [SIMULATOR_SERVER_NAMESPACE, TV_CONTROL_NAMESPACE];

      const snapshot = registry.getSnapshot();
      let stopped = false;
      for (const namespace of namespaces) {
        const urn = `${namespace}:${udid}`;
        const entry = snapshot.services.get(urn);
        if (!entry || entry.state === ServiceState.IDLE) continue;
        // A non-live node (ERROR / TERMINATING) holds no running process — e.g.
        // a tvOS UDID, where the SimulatorServer blueprint throws on start and
        // the node settles into ERROR. Clean it up, but don't claim we stopped a
        // server that was never running.
        if (isLiveServiceState(entry.state)) stopped = true;
        await registry.disposeService(urn);
      }
      return { stopped, udid };
    },
  };
}
