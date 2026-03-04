import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  expression: z.string().describe("JavaScript expression to evaluate in the app runtime"),
});

export const metroEvaluateTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { result: unknown }
> = {
  id: "metro-evaluate",
  description: `Execute arbitrary JavaScript in the React Native app's JS runtime via CDP.
Returns the evaluation result. The app must be connected via metro-connect first (auto-connects if needed).`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.metroDebugger as MetroDebuggerApi;
    const result = await api.cdp.evaluate(params.expression);
    return { result };
  },
};
