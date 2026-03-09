import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
});

export const debuggerResumeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { resumed: boolean }
> = {
  id: "debugger-resume",
  description: `Resume JavaScript execution after a pause or breakpoint hit.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    await api.cdp.send("Debugger.resume");
    return { resumed: true };
  },
};
