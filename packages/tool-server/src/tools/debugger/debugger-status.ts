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
  description: `Get the current JS runtime debugger connection status and diagnostic information.
Use when checking whether the debugger is connected, verifying source maps are loaded before setting breakpoints, or diagnosing why breakpoints are not resolving.

Parameters: port — Metro server TCP port (default 8081, e.g. 8081).
Example: { "port": 8081 }
Returns { port, projectRoot, deviceName, connected, loadedScripts, enabledDomains, sourceMapReady }. Auto-connects if not already connected. Fails if Metro is not running on the specified port.`,
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
