import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  breakpointId: z
    .string()
    .describe("Breakpoint ID returned by debugger-set-breakpoint"),
});

export const debuggerRemoveBreakpointTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { removed: boolean }
> = {
  id: "debugger-remove-breakpoint",
  description: `Remove a previously set breakpoint by its ID.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    await api.cdp.send("Debugger.removeBreakpoint", {
      breakpointId: params.breakpointId,
    });
    return { removed: true };
  },
};
