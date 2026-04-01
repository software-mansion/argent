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
  description: `Execute arbitrary JavaScript in the React Native app's JS runtime via CDP and return the result.
Use when inspecting runtime state, reading global variables, calling app functions, or verifying logic without modifying source code.

Parameters: port — Metro server TCP port (default 8081); expression — any valid JavaScript expression (e.g. "typeof globalThis.__fbBatchedBridge").
Example: { "port": 8081, "expression": "JSON.stringify(window.__MY_DEBUG_STATE)" }
Returns { result }. Auto-connects to debugger if not already connected. Returns an error if Metro is not running or the expression throws — call debugger-connect first if the auto-connect fails.`,
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
