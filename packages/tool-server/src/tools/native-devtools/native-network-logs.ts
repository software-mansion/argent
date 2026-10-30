import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
  type NetworkEvent,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; count: number; events: NetworkEvent[] };

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe("Maximum number of events to return (most recent first)"),
  clear: z.boolean().optional().default(false).describe("Clear the log after reading"),
});

type Params = z.infer<typeof zodSchema>;

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
  id: "native-network-logs",
  description: `Retrieve network requests captured at the native NSURLProtocol level.
Unlike view-network-logs, it also sees URLSession requests (default and ephemeral session configurations, and URLSession.shared) from native modules and Swift/Objective-C code. It does not see background URLSession transfers, WKWebView, Network.framework, or HTTP stacks that bypass URLSession (e.g. Flutter), so an empty result does not mean the app sent nothing. Capture starts at the first call, so the first call is usually empty: repeat the action, then call again.
Use when inspecting native-level HTTP traffic that view-network-logs cannot see.
Returns { status, count, events } where each event contains URL, method, status code, headers, and timing.
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
On a device whose devtools agent argent attached to rather than armed itself, a not-connected app fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\` instead of a status, and no restart on argent's side fixes it. An Apple system app is rejected outright (terminal: never retry it).`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) => `Reading native network activity for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native network activity for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true }, appleRemote: { simulator: true } },
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
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
