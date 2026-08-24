import { z } from "zod";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DISABLE_LOGBOX_SCRIPT } from "../../utils/debugger/scripts/disable-logbox";
import { RN_ONLY_TOOL_CAPABILITY } from "./debugger-service-ref";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID or Android serial)."
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
  interaction: {
    startedMsg: () => "Reloading the app through Metro",
    completedMsg: () => "Reloaded the app through Metro",
    failedMsg: ({ failureSignal }) =>
      `Failed to reload the app through Metro: ${failureSignal.error_code}`,
  },
  description: `Restart the Metro JS bundle in the connected React Native app without restarting the native process.
Use when you want to apply code changes or reset JS state. Returns { reloaded, port, method, deviceName, appName, logicalDeviceId } indicating which reload path was used and which device/app was targeted. Fails if Metro is not running on the given port.`,
  zodSchema,
  // RN-only: reloading a Chromium page is a different operation from restarting
  // the Metro bundle, so it would need its own tool.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}:${canonicalDeviceId(params.device_id)}`,
  }),
  async execute(services, _params) {
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
    } catch {
      /* fall through */
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
