import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import {
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
  type NetworkEvent,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
import {
  nativeAppServices,
  nativeAppTarget,
  requireMacosAppOfBundle,
} from "./macos-view-hierarchy";

const zodSchema = z.object({
  ...nativeAppTarget,
  limit: z
    .number()
    .optional()
    .default(50)
    .describe("Maximum number of events to return (most recent first)"),
  clear: z.boolean().optional().default(false).describe("Clear the log after reading"),
});

type Params = z.infer<typeof zodSchema>;
type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; count: number; events: NetworkEvent[] };

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
  id: "native-network-logs",
  interaction: {
    startedMsg: ({ params }) => `Reading native network activity for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native network activity for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: {
    apple: { simulator: true },
    appleRemote: { simulator: true },
    macos: { app: true },
  },
  description: `Retrieve network requests captured at the native NSURLProtocol level. 
Unlike view-network-logs, it also sees URLSession requests (default and ephemeral session configurations, and URLSession.shared) from native modules and Swift/Objective-C code. It does not see background URLSession transfers, WKWebView, Network.framework, or HTTP stacks that bypass URLSession (e.g. Flutter), so an empty result does not mean the app sent nothing. Capture starts at the first call, so the first call is usually empty: repeat the action, then call again. 
Use when you need to inspect native-level HTTP traffic that is invisible to the JS-level capture. 
Returns { status, count, events } where each event contains URL, method, status code, headers, and timing.
<flag:macos-apps>
For a Mac app device (macos-app-<bundle id>), argent records requests sent through NSURLSession, react-native-macos fetch included, with identical event fields. The first call turns the capture on, and requests sent before it are not in the log: call it once, then repeat the action that sends the requests. Capture stays on across restart-app, so a restart records launch requests; each new process starts an empty log. Statuses below apply to simulators only: when the Mac app has quit, this fails with MACOS_APP_NOT_RUNNING.

</flag:macos-apps>If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-running app comes back as one of those statuses rather than a failure. An app that is not connected does too, except on a device whose devtools agent argent attached to rather than armed itself: there it fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\`, since no restart of ours can complete a handshake we do not own. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), while a missing host dependency or a udid that is not an Apple device is not.`,
  zodSchema,
  services: nativeAppServices,
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (device.platform === "macos") {
      const app = requireMacosAppOfBundle(services, device, "native-network-logs", params.bundleId);
      await app.activateNetworkInspection();
      const events = app.networkLog().slice(-params.limit);
      if (params.clear) app.clearNetworkLog();
      return { status: "ok", count: events.length, events };
    }
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
    if (blocked) return blocked;

    /**
     * `{count: 0}` reads as "the screen made no requests", so say when the
     * truth is "nothing is capturing them", as the hierarchy tools do.
     */
    if (!api.isConnected(params.bundleId)) {
      throw new FailureError(
        `Native devtools not connected for bundleId: ${params.bundleId}. ` +
          `No network log is being captured for it.`,
        {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
          error_kind: "not_found",
          failure_area: "tool_server",
          failure_stage: "native_network_logs_connection",
        }
      );
    }

    api.activateNetworkInspection(params.bundleId);

    const events = api.getNetworkLog(params.bundleId).slice(-params.limit);
    if (params.clear) api.clearNetworkLog(params.bundleId);
    return { status: "ok", count: events.length, events };
  },
};
