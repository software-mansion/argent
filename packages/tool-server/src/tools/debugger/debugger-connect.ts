import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";

const zodSchema = z.object({
  port: z.coerce
    .number()
    .default(8081)
    .describe("Metro server port (ignored for Chromium — its CDP port is encoded in device_id)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: iOS simulator UDID, Android serial, Vega serial (amazon-...), or Chromium device id (chromium-cdp-<port>). Pass this SAME id as device_id to every subsequent debugger-* call to pin them to this device. The returned logicalDeviceId is informational (Metro's own per-connection handle, absent on Vega); you do not switch to it — forwarding it still resolves here, but the list-devices id is the stable one."
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
iOS / Android / Vega: connects to Metro's CDP endpoint on the given port. Chromium: re-uses the page CDP session opened by boot-device — port is ignored.
Returns connection info including port, projectRoot (empty on Chromium and on legacy Metro, e.g. Vega), deviceName, appName, logicalDeviceId (absent on Vega), and isNewDebugger. If already connected, returns the existing connection.
Use when starting a debug session or before calling other debugger-* tools. Fails if the runtime is unreachable (Metro down, or Chromium CDP terminated).`,
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
