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
  description: `Get a summary of all console logs captured from the React Native app. Use when diagnosing errors, warnings, or unexpected app behavior by reviewing captured log output.
Accepts: port (default 8081, e.g. 8082 for a secondary Metro instance).
Returns the log file path, entry counts by level such as "warn" or "error", and message clusters grouped by similarity.
Use this tool first to get an overview, then read the returned file path for details.
Fails if no debugger connection can be established.`,
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
