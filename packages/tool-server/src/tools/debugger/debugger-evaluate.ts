import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Target device id (logicalDeviceId from debugger-connect, equivalent to udid from list-devices)."
    ),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown; deviceName: string; appName: string; logicalDeviceId: string | undefined }
> = {
  id: "debugger-evaluate",
  description: `Execute arbitrary JavaScript in the React Native app's JS runtime via CDP.
Returns the evaluation result as a JSON-serializable value, along with deviceName, appName, and logicalDeviceId for context. Use when you need to read app state, call app functions, or test logic at runtime. Fails if the expression throws or the runtime is not connected.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}:${params.device_id}`,
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
