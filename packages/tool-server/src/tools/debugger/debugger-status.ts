import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerStatusTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    port: number;
    projectRoot: string;
    deviceName: string;
    isNewDebugger: boolean;
    connected: boolean;
    loadedScripts: number;
    enabledDomains: string[];
    sourceMapReady: boolean;
  }
> = {
  id: "debugger-status",
  description: `Get JS runtime debugger connection status and diagnostic info.
Connects to the debugger if not already connected (idempotent with debugger-connect).
Includes source map readiness status for breakpoint resolution.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    await api.sourceMaps.waitForPending();
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
      loadedScripts: api.cdp.getLoadedScripts().size,
      enabledDomains: [...api.cdp.getEnabledDomains()],
      sourceMapReady: true,
    };
  },
};
