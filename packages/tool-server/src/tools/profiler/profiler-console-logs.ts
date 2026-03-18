import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  type JsRuntimeDebuggerApi,
} from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  level: z
    .enum(["log", "warn", "error", "all"])
    .default("all")
    .describe("Filter log entries by level (default: all)"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(100)
    .describe("Maximum number of log entries to return (default 100)"),
});

export const profilerConsoleLogsTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { total: number; returned: number; entries: unknown[] }
> = {
  id: "profiler-console-logs",
  description: `Return console log entries captured from the connected React Native app.
Supports filtering by log level (log, warn, error, all). Returns the most recent N entries.`,
  zodSchema,
  services: (params) => ({
    debugger: `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;

    const { entries, total } = api.logWriter.readFiltered({
      level: params.level === "all" ? undefined : params.level,
      limit: params.limit,
    });

    return {
      total,
      returned: entries.length,
      entries: entries.map((entry) => ({
        id: entry.id,
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
      })),
    };
  },
};
