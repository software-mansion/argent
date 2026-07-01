import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";

const PREFIXES = [
  `${SIMULATOR_SERVER_NAMESPACE}:`,
  `${NATIVE_DEVTOOLS_NAMESPACE}:`,
  `${ANDROID_DEVTOOLS_NAMESPACE}:`,
  `${CHROMIUM_CDP_NAMESPACE}:`,
  // The Apple TV service owns two spawned daemons (in-sim tvos-ax-service +
  // host-side tvos-hid-daemon, both --timeout 3600); only its dispose() reaps
  // them and unlinks the sockets. Without this prefix a session-end stop leaves
  // them running for up to an hour. (AndroidTvControl is stateless adb shell-outs
  // with a no-op dispose, but include it for symmetry so the snapshot is fully
  // drained.)
  `${TV_CONTROL_NAMESPACE}:`,
  `${ANDROID_TV_CONTROL_NAMESPACE}:`,
];

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<void, { stopped: string[] }> {
  return {
    id: "stop-all-simulator-servers",
    description: `Stop all running simulator-server processes (iOS + Android), native devtools services, and Chromium CDP sessions, freeing their resources. Call this when your session ends or the user says they are done. Returns { stopped } — an array of URNs that were shut down. Fails silently if no servers are running.`,
    services: () => ({}),
    async execute() {
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      for (const [urn, entry] of snapshot.services) {
        if (PREFIXES.some((p) => urn.startsWith(p)) && entry.state !== ServiceState.IDLE) {
          // Dispose any non-IDLE node (this also clears ERROR/TERMINATING
          // nodes), but only report the ones that were actually live — an
          // ERROR node (e.g. a tvOS SimulatorServer that refused to start)
          // was never a running server.
          const wasLive = isLiveServiceState(entry.state);
          await registry.disposeService(urn);
          if (wasLive) stopped.push(urn);
        }
      }
      return { stopped };
    },
  };
}
