import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const metroStatusTool: ToolDefinition<
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
  id: "metro-status",
  description: `Get Metro debugger connection status and diagnostic info.
Connects to Metro if not already connected (idempotent with metro-connect).
Includes source map readiness status for breakpoint resolution.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.metroDebugger as MetroDebuggerApi;
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
