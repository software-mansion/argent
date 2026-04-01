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
  description: `Execute arbitrary JavaScript in the React Native app's JS runtime via CDP. Use when you need to inspect state, call functions, or test expressions at runtime.
Accepts: expression (required, e.g. "global.__DEV__") and port (default 8081).
Returns the evaluation result as { result }. The app must be connected via debugger-connect first (auto-connects if needed).
Fails if the runtime is paused at a breakpoint or the expression throws an unhandled error.`,
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
