import { z } from "zod";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { MACOS_APP_ID_PREFIX } from "../../utils/device-info";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DISABLE_LOGBOX_SCRIPT } from "../../utils/debugger/scripts/disable-logbox";
import { RN_ONLY_TOOL_CAPABILITY } from "./debugger-service-ref";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: the SAME id you passed to debugger-connect (iOS simulator UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android serial)."
    ),
});

export const debuggerReloadMetroTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    reloaded: boolean;
    port: number;
    method: "cdp" | "http";
    deviceName: string;
    appName: string;
    logicalDeviceId: string | undefined;
  }
> = {
  id: "debugger-reload-metro",
  description: `Restart the Metro JS bundle in the connected React Native app without restarting the native process.
Use when you want to apply code changes or reset JS state. Returns { reloaded, port, method (cdp or http), deviceName, appName, logicalDeviceId }. Fails if Metro is not running on the given port.<flag:macos-apps> On a Mac app it reloads only through the debugger connection, and fails when that reload fails.</flag:macos-apps>`,
  zodSchema,
  interaction: {
    startedMsg: () => "Reloading the app through Metro",
    completedMsg: () => "Reloaded the app through Metro",
    failedMsg: ({ failureSignal }) =>
      `Failed to reload the app through Metro: ${failureSignal.error_code}`,
  },
  // RN-only: reloading a Chromium page is a different operation from restarting
  // the Metro bundle, so it would need its own tool.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${metroPort(params)}:${canonicalDeviceId(params.device_id)}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const port = api.port;

    const disableLogBox = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 2000)).then(() =>
        api.cdp.evaluate(DISABLE_LOGBOX_SCRIPT).catch(() => {})
      );

    const context = {
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
    };

    try {
      await api.cdp.send("Page.reload");
      void disableLogBox();
      return { reloaded: true, port, method: "cdp", ...context };
    } catch (err) {
      // Metro's HTTP /reload reaches every app on this Metro. A Mac app often
      // shares its Metro with a simulator of the same project, so a reload of the
      // Mac app must not reload that simulator too.
      if (canonicalDeviceId(params.device_id)?.startsWith(MACOS_APP_ID_PREFIX)) {
        throw new FailureError(
          `Failed to reload the Mac app: CDP Page.reload failed (${
            err instanceof Error ? err.message : String(err)
          }). argent does not fall back to Metro's HTTP /reload for a Mac app, because ` +
            `that reloads every app on this Metro. Restart the app (restart-app) instead.`,
          {
            error_code: FAILURE_CODES.DEBUGGER_RELOAD_FAILED,
            failure_stage: "debugger_reload_metro",
            failure_area: "tool_server",
            error_kind: "network",
          }
        );
      }
    }

    const res = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new FailureError(
        `Failed to reload: CDP Page.reload unsupported and Metro HTTP /reload returned ${res.status} ${res.statusText}.`,
        {
          error_code: FAILURE_CODES.DEBUGGER_RELOAD_FAILED,
          failure_stage: "debugger_reload_metro",
          failure_area: "tool_server",
          error_kind: "network",
        }
      );
    }
    void disableLogBox();
    return { reloaded: true, port, method: "http", ...context };
  },
};
