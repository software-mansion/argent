import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const metroResumeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { resumed: boolean }
> = {
  id: "metro-resume",
  description: `Resume JavaScript execution after a pause or breakpoint hit.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.metroDebugger as MetroDebuggerApi;
    await api.cdp.send("Debugger.resume");
    return { resumed: true };
  },
};
