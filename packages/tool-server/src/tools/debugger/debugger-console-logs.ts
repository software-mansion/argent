import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi, ConsoleLogEntry } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  count: z
    .union([z.coerce.number().int().positive(), z.literal("all")])
    .default("all")
    .describe('Number of recent console logs to return, or "all" for every buffered log'),
  sinceId: z
    .coerce.number()
    .int()
    .optional()
    .describe("Only return logs with id strictly greater than this value"),
});

export const debuggerConsoleLogsTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { logs: ConsoleLogEntry[]; total: number }
> = {
  id: "debugger-console-logs",
  description: `Read console logs from the React Native app runtime.
Returns the most recent N logs, or all buffered logs if count is "all".
Pass sinceId to only receive logs newer than a known cursor.
The app must be connected via debugger-connect first (auto-connects if needed).`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;

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
