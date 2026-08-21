import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
  type NetworkEvent,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

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
type Result = NativeDevtoolsPrecheckBlock | { status: "ok"; count: number; events: NetworkEvent[] };

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
  id: "native-network-logs",
  interaction: {
    startedMsg: ({ params }) => `Reading native network activity for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native network activity for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  // `apple.device: false`: native-devtools injects its dylib with DYLD via
  // `simctl spawn`, which is simulator-only — a signed app on a physical iPhone
  // cannot load it, so the blueprint refuses `kind: "device"` outright. Gate here
  // too so a physical udid is rejected by the capability check with a clear
  // message instead of reaching the blueprint's throw.
  capability: { apple: { simulator: true, device: false }, appleRemote: { simulator: true } },
  description: `Retrieve network requests captured at the native NSURLProtocol level. 
Unlike the JS-level network inspector (view-network-logs), this captures ALL network traffic from the app including native modules, Swift/Objective-C networking, and background transfers that bypass JS fetch. 
Use when you need to inspect native-level HTTP traffic that is invisible to JS fetch interception. 
Returns { status, count, events } where each event contains URL, method, status code, headers, and timing.
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting — do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised — follow the message (re-boot the simulator) rather than retrying this tool.
A not-connected or not-running app comes back as one of those statuses rather than a failure. Failures are separate: an Apple system app is rejected outright (terminal — never retry it), while a missing host dependency or a udid that is not an Apple device is not.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

    const api = services.nativeDevtools as NativeDevtoolsApi;

    const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
    if (blocked) return blocked;

    api.activateNetworkInspection(params.bundleId);

    const events = api.getNetworkLog(params.bundleId).slice(-params.limit);
    if (params.clear) api.clearNetworkLog(params.bundleId);
    return { status: "ok", count: events.length, events };
  },
};
