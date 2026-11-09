import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import { describeReapedSession, takeReapedSessionAnyId } from "../../utils/reaped-sessions";

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: iOS simulator UDID, Android serial, Vega serial (amazon-...), or Chromium device id (chromium-cdp-<port>). Pass this SAME id as device_id to every subsequent debugger-* call to pin them to this device. The returned logicalDeviceId is informational (Metro's own per-connection handle, absent on Vega); you do not switch to it. Forwarding it still resolves here, but the list-devices id is the stable one."
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
    note?: string;
  }
> = {
  id: "debugger-connect",
  description: `Connect to a JS runtime CDP debugger.
iOS / Android / Vega: connects to Metro's CDP endpoint on the given port. Chromium: re-uses the page CDP session opened by boot-device.
Returns connection info including port, projectRoot (empty on Chromium and on legacy Metro, e.g. Vega), deviceName, appName, logicalDeviceId, and isNewDebugger, plus a note naming the kept log file when the previous session ended because the app crashed. If already connected, returns the existing connection.
Use when starting a debug session or before calling other debugger-* tools. Fails if the runtime is unreachable (Metro down, or Chromium CDP terminated).`,
  zodSchema,
  interaction: {
    startedMsg: () => "Connecting JavaScript debugger",
    completedMsg: ({ result }) =>
      `Connected JavaScript debugger to ${result.appName || result.deviceName}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to connect JavaScript debugger: ${failureSignal.error_code}`,
  },
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    // Take this device's breadcrumb: `debugger-log-registry` reads it only on
    // an empty or not-connected read, so one left here outlives every read that
    // finds entries and later pins an unrelated empty read on the old session.
    // An explicit connect makes it wrong anyway — from here the capture is this
    // session's.
    //
    // Not in the blueprint's factory: that also runs for the implicit resolve
    // `debugger-log-registry` reconnects through, which would consume the
    // breadcrumb just before the read that exists to report it.
    const reaped = takeReapedSessionAnyId("js-runtime-debugger", [
      params.device_id,
      api.logicalDeviceId,
    ]);
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
      ...(reaped?.connectionLost
        ? { note: describeReapedSession(reaped, "previous JS-runtime debugger session") }
        : {}),
    };
  },
};
