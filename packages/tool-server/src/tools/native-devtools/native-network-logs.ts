import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi, NetworkEvent } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe("Maximum number of events to return (most recent first)"),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe("Clear the log after reading"),
});

type Params = z.infer<typeof zodSchema>;
type Result =
  | { status: "restart_required"; message: string }
  | { status: "ok"; count: number; events: NetworkEvent[] };

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
  id: "native-network-logs",
  description: `View network requests captured at the native NSURLProtocol level.

Unlike the JS-level network inspector (view-network-logs), this captures ALL network
traffic from the app including native modules, Swift/Objective-C networking, and
background transfers that bypass JS fetch.

If requiresRestart is returned: call restart-app then retry.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  async execute(services, params) {
    const api = services.nativeDevtools as NativeDevtoolsApi;

    if (await api.requiresAppRestart(params.bundleId)) {
      return {
        status: "restart_required",
        message:
          "Native devtools are not injected into the running app. " +
          "Call restart-app then retry.",
      };
    }

    api.activateNetworkInspection(params.bundleId);

    const events = api.getNetworkLog(params.bundleId).slice(-params.limit);
    if (params.clear) api.clearNetworkLog(params.bundleId);
    return { status: "ok", count: events.length, events };
  },
};
