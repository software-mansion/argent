import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";

interface LogRegistryResponse extends LogStats {
  clusters: MessageCluster[];
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerLogRegistryTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  LogRegistryResponse
> = {
  id: "debugger-log-registry",
  description: `Get a summary of all console logs captured from the running React Native app.
Use when investigating errors, warnings, or unexpected app behavior — call this first for an overview, then read the returned log file path for full details.

Parameters: port — Metro server TCP port (default 8081, e.g. 8081).
Example: { "port": 8081 }
Returns { logFilePath, counts: { debug, info, warn, error }, clusters: [...] } where clusters group similar messages by pattern. Auto-connects to debugger if needed. Returns an error if Metro is not running — call debugger-connect first.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const stats = api.logWriter.getStats();
    const clusters = api.logWriter.getClusters(20);

    return {
      ...stats,
      clusters,
    };
  },
};
