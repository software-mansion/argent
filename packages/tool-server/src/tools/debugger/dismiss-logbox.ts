import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DISABLE_LOGBOX_SCRIPT } from "../../utils/debugger/scripts/disable-logbox";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId). " +
        "Auto-connects the JS runtime debugger if not already connected."
    ),
});

export const dismissLogboxTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { dismissed: boolean; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "dismiss-logbox",
  description:
    "Hide the React Native LogBox banner (yellow warnings + red non-fatal errors) at the " +
    "bottom of the screen. Does NOT affect the fullscreen LogBox shown for fatal/uncaught " +
    "errors — those remain visible. Idempotent and safe to call repeatedly. Auto-connects " +
    "the JS runtime debugger if needed; once connected, the banner stays hidden across JS " +
    "reloads for the rest of the session. Call once near the start of any RN session, " +
    "and never tap the banner directly (the X target overlaps the bottom tab bar in most apps).",
  alwaysLoad: true,
  searchHint: "logbox banner warning error dismiss hide notification redbox yellow",
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    await api.cdp.evaluate(DISABLE_LOGBOX_SCRIPT);
    return {
      dismissed: true,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
    };
  },
};
