import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { isExternalId } from "../../utils/external-devices";
import {
  deviceIdOwningUrn,
  isAttachedSimulatorServerUrn,
  transportNamespacesForPlatform,
} from "./device-services";

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
    description: `Stop the transport session for one device (simulator-server, physical iOS runner, Chromium CDP, or TV daemons).
Use when restarting a wedged transport or freeing one device without affecting others (not routinely after every task; use \`stop-all-simulator-servers\` with \`devices\` to also stop devtools/profilers/debuggers). On Chromium, also ends the JS debugger session.<flag:macos-apps> On Mac apps, also stops native capture (discarding records) and screen recording.</flag:macos-apps>
Returns \`{ stopped, udid }\` (\`stopped: false\` if none was running). Fails only on invalid input.`,
    zodSchema,
    interaction: {
      startedMsg: ({ params }) => `Stopping simulator server for ${params.udid}`,
      completedMsg: ({ params }) => `Stopped simulator server for ${params.udid}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to stop simulator server for ${params.udid}: ${failureSignal.error_code}`,
    },
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

      /**
       * An external device has no server of ours to stop. Its `dispose()` is
       * a no-op by design. Still drop the cached handles so the next call
       * re-resolves against the provider's state, but report `stopped: false`.
       * A clean no-op beats an error for an agent that calls this on every device.
       */
      const external = isExternalId(udid);

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

        if (external || isAttachedSimulatorServerUrn(urn)) {
          await registry.disposeService(urn);
          continue;
        }

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
