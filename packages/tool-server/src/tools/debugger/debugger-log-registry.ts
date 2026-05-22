import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";

interface LogRegistryResponse extends LogStats {
  clusters: MessageCluster[];
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Electron)"),
  device_id: z
    .string()
    .describe(
      "Device id from debugger-connect (iOS simulator UDID, Android logicalDeviceId, or Electron device id)."
    ),
});

export const debuggerLogRegistryTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  LogRegistryResponse
> = {
  id: "debugger-log-registry",
  description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Works against Hermes (iOS / Android) and V8 (Electron).
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const stats = api.logWriter.getStats();
    const clusters = api.logWriter.getClusters(20);

    return {
      ...stats,
      clusters,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
    };
  },
};
