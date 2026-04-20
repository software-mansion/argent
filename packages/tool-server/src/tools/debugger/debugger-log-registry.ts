import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";

interface LogRegistryResponse extends LogStats {
  clusters: MessageCluster[];
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Target device id (logicalDeviceId from debugger-connect, equivalent to udid from list-devices)."
    ),
});

export const debuggerLogRegistryTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  LogRegistryResponse
> = {
  id: "debugger-log-registry",
  description: `Get a summary of all console logs captured from the React Native app.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity).
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}:${params.device_id}`,
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
