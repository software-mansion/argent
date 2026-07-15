import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from debugger-connect (iOS simulator UDID, Android logicalDeviceId, Vega serial, or Chromium device id)."
    ),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "debugger-evaluate",
  description: `Execute arbitrary JavaScript in the app's JS runtime via CDP — Hermes on iOS / Android / Vega, V8 on Chromium.
Returns the evaluation result as a JSON-serializable value, along with deviceName, appName, and logicalDeviceId for context. Use when you need to read app state, call app functions, or test logic at runtime. The result is serialized by value, so cyclic objects (many RN runtime values — fiber nodes, navigation refs, global — are cyclic) fail with a serialization error rather than returning silently. Fails if the expression throws or the runtime is not connected.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const result = await api.cdp.evaluate(params.expression);
    return {
      result,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
    };
  },
};
