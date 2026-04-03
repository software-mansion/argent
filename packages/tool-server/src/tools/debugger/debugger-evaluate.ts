import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const debuggerEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown }
> = {
  id: "debugger-evaluate",
  description: `Execute arbitrary JavaScript in the React Native app's JS runtime via CDP.
Returns the evaluation result as a JSON-serializable value. Use when you need to read app state, call app functions, or test logic at runtime. Fails if the expression throws or the runtime is not connected.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const result = await api.cdp.evaluate(params.expression);
    return { result };
  },
};
