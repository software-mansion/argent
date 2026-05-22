import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";

const zodSchema = z.object({
  port: z.coerce
    .number()
    .default(8081)
    .describe("Metro server port (ignored for Electron — its CDP port is encoded in device_id)"),
  device_id: z
    .string()
    .describe(
      "Device id: iOS simulator UDID, Android logicalDeviceId returned by Metro, or Electron device id (electron-cdp-<port>) from list-devices. The returned logicalDeviceId must be forwarded as device_id to all subsequent debugger-* calls to pin them to this device."
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
  description: `Connect to a JS runtime CDP debugger.
iOS / Android: connects to Metro's CDP endpoint on the given port. Electron: re-uses the page CDP session opened by boot-device — port is ignored.
Returns connection info including port, projectRoot (empty on Electron), deviceName, appName, logicalDeviceId, and isNewDebugger. If already connected, returns the existing connection.
Use when starting a debug session or before calling other debugger-* tools. Fails if the runtime is unreachable (Metro down, or Electron CDP terminated).`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
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
