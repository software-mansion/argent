import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
  file: z
    .string()
    .describe(
      "Source file path relative to project root (e.g. 'App.tsx' or 'src/screens/Home.tsx')"
    ),
  line: z.number().describe("Line number (1-based)"),
  column: z.number().optional().describe("Column number (0-based)"),
  condition: z.string().optional().describe("Conditional breakpoint expression"),
});

export const debuggerSetBreakpointTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    breakpointId: string;
    locations: unknown[];
    resolvedSource?: string;
    generatedLine?: number;
    generatedColumn?: number;
  }
> = {
  id: "debugger-set-breakpoint",
  description: `Set a breakpoint at a file:line in the app's source code.
Uses source maps to resolve the original source position to the correct
generated position in the Metro bundle, then calls Debugger.setBreakpointByUrl.
Returns the breakpointId (needed for removal) and resolved locations.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;

    const filePath = params.file.replace(/\\/g, "/").replace(/^\/+/, "");

    await api.sourceMaps.waitForPending();

    const generated = api.sourceMaps.toGeneratedPosition(
      filePath,
      params.line,
      params.column ?? 0
    );

    if (!generated) {
      throw new Error(
        `Could not resolve source position for "${filePath}:${params.line}" ` +
          `in any loaded source map. Ensure the file is part of the bundle ` +
          `and the path is relative to the project root (${api.projectRoot}).`
      );
    }

    const cdpParams: Record<string, unknown> = {
      lineNumber: generated.line1Based - 1,
      url: generated.scriptUrl,
      columnNumber: generated.column0Based,
    };
    if (params.condition) cdpParams.condition = params.condition;

    const result = (await api.cdp.send(
      "Debugger.setBreakpointByUrl",
      cdpParams
    )) as { breakpointId: string; locations: unknown[] };

    return {
      breakpointId: result.breakpointId,
      locations: result.locations ?? [],
      resolvedSource: api.sourceMaps.findMatchingSource(filePath) ?? undefined,
      generatedLine: generated.line1Based,
      generatedColumn: generated.column0Based,
    };
  },
};
