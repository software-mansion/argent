import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  DEBUGGER_TOOL_CAPABILITY,
  debuggerServiceRef,
  reapedDebuggerKind,
} from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import { describeReapedSession, takeReapedSessionAnyId } from "../../utils/reaped-sessions";

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from `list-devices`: iOS UDID, Android/Vega serial, <flag:macos-apps>Mac app id (`macos-app-<bundle id>`), </flag:macos-apps>or Chromium id (`chromium-cdp-<port>`). Reuse this same id on subsequent `debugger-*` calls (or pass the error's `logicalDeviceId` if shared Metro is ambiguous)."
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
  description: `Connect to an app's JS debugger (React Native via Metro, or Chromium CDP) and start capturing console logs; reuses existing connections.<flag:macos-apps> Mac apps need a Debug build loading JS from Metro (react-native-macos 0.76+ or Mac Catalyst launched via Argent).</flag:macos-apps>
Use when starting a debug session or before other \`debugger-*\` tools (keep the same \`device_id\`; retry with \`logicalDeviceId\` only if shared Metro reports ambiguity<flag:macos-apps>; Mac apps always keep the Mac app id</flag:macos-apps>).
Returns connection info (plus \`note\` with prior log path after a crash). Fails if the runtime is unreachable.`,
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
    const reaped = takeReapedSessionAnyId(reapedDebuggerKind(params), [
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
