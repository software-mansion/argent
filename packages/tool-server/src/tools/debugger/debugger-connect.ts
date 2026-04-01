import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerConnectTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    port: number;
    projectRoot: string;
    deviceName: string;
    isNewDebugger: boolean;
    connected: boolean;
  }
> = {
  id: "debugger-connect",
  description: `Connect to a running Metro dev server's CDP WebSocket endpoint to start a JS debugging session. Use when opening a new debug session or before calling other debugger-* tools.
Accepts: port (default 8081, e.g. 8081 for the standard Metro instance).
Returns { port, projectRoot, deviceName, isNewDebugger, connected }. Idempotent: if already connected, returns the existing session.
Fails if Metro is not running or no JS app is attached to the debug endpoint.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
    };
  },
};
