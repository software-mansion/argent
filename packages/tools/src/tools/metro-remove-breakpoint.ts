import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  breakpointId: z
    .string()
    .describe("Breakpoint ID returned by metro-set-breakpoint"),
});

export const metroRemoveBreakpointTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { removed: boolean }
> = {
  id: "metro-remove-breakpoint",
  description: `Remove a previously set breakpoint by its ID.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.metroDebugger as MetroDebuggerApi;
    await api.cdp.send("Debugger.removeBreakpoint", {
      breakpointId: params.breakpointId,
    });
    return { removed: true };
  },
};
