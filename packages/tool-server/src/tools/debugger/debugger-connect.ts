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
  description: `Connect to a running Metro dev server's CDP (Chrome DevTools Protocol) debugger endpoint.
Use when starting a debugging session, before setting breakpoints, evaluating JS, or inspecting the React component tree. Other debugger-* tools auto-connect, but calling this first is recommended.

Parameters: port — Metro server TCP port (default 8081, e.g. 8081 or 8088).
Example: { "port": 8081 }
Returns { port, projectRoot, deviceName, isNewDebugger, connected }. Fails if Metro is not running on the specified port — start Metro first (e.g. npx react-native start).`,
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
