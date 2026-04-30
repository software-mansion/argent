import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId (iOS simulator UDID or Android logicalDeviceId returned by Metro). The returned logicalDeviceId must be forwarded as device_id to all subsequent debugger-* and profiler-* calls to pin them to this device."
    ),
});

export const debuggerConnectTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    port: number;
    projectRoot: string;
    deviceName: string;
    appName: string;
    logicalDeviceId: string | undefined;
    isNewDebugger: boolean;
    connected: boolean;
  }
> = {
  id: "debugger-connect",
  description: `Connect to a running Metro dev server's CDP debugger endpoint.
Returns connection info including port, projectRoot, deviceName, appName, logicalDeviceId, and isNewDebugger. If already connected, returns the existing connection.
Use when starting a debug session or before calling other debugger-* tools. Fails if Metro is not running on the specified port.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
    };
  },
};
