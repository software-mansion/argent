import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi, ConsoleLogEntry } from "../blueprints/metro-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  count: z
    .union([z.number().int().positive(), z.literal("all")])
    .default("all")
    .describe('Number of recent console logs to return, or "all" for every buffered log'),
  sinceId: z
    .number()
    .int()
    .optional()
    .describe("Only return logs with id strictly greater than this value"),
});

export const metroConsoleLogsTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { logs: ConsoleLogEntry[]; total: number }
> = {
  id: "metro-console-logs",
  description: `Read console logs from the React Native app runtime.
Returns the most recent N logs, or all buffered logs if count is "all".
Pass sinceId to only receive logs newer than a known cursor.
The app must be connected via metro-connect first (auto-connects if needed).`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.metroDebugger as MetroDebuggerApi;

    let logs = api.consoleLogs;

    if (params.sinceId !== undefined) {
      const idx = logs.findIndex((l) => l.id > params.sinceId!);
      logs = idx === -1 ? [] : logs.slice(idx);
    }

    if (params.count !== "all") {
      logs = logs.slice(-params.count);
    }

    return { logs: [...logs], total: api.consoleLogs.length };
  },
};
