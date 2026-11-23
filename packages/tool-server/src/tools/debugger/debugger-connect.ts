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
      "Device id from list-devices: iOS simulator UDID, Android serial, Vega serial (amazon-...), <flag:macos-apps>Mac app id (macos-app-<bundle id>), </flag:macos-apps>or Chromium device id (chromium-cdp-<port>). Pass this SAME id as device_id to every subsequent debugger-* call to pin them to this device. The returned logicalDeviceId is informational (Metro's own per-connection handle, absent on Vega); you do not switch to it. Forwarding it still resolves here, but the list-devices id is the stable one. On a Metro shared by several devices, a simulator UDID or Android serial is matched by the device's name (a simulator's name; an Android model, release and API level); the app's device log must then confirm it runs there. When another booted simulator or attached device shares that name, or the log does not confirm it, the error asks for the logicalDeviceId instead."
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
  description: `Connect to an app's JavaScript debugger and start collecting console logs. Reuses an existing connection. React Native apps connect through Metro. Chromium uses the page's existing CDP session.<flag:macos-apps> Mac apps need a Debug build that loads JavaScript from Metro (react-native-macos 0.76+ or React Native for Mac Catalyst). Launch Mac Catalyst through Argent so it can identify the runtime.</flag:macos-apps>
Use when starting a debug session or before calling other debugger-* tools. Keep the same device_id for later debugger calls. If shared Metro reports an ambiguous iOS simulator or Android target, retry with the intended device's logicalDeviceId from the error.<flag:macos-apps> Keep the Mac app id on shared Metro. If its runtime is missing, check the build and Metro port. The listed IDs belong to other targets.</flag:macos-apps>
Returns connection details and, after a crash, a note with the previous log path if available. On Chromium or legacy Metro (such as Vega), projectRoot is empty. Fails if the runtime is unreachable.`,
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
    // Take this device's breadcrumb: from an explicit connect on, the capture is
    // this session's, so a later read must not blame the old session.
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
