import { z } from "zod";
import { promises as fs } from "fs";
import type { ToolDefinition } from "@argent/registry";
import { PROFILER_SESSION_NAMESPACE } from "../../blueprints/profiler-session";
import { buildAstIndexWithDiagnostics } from "../../utils/profiler/pipeline/06-resolve/ast-index";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  component_name: z.string().describe("Name of the React component to look up"),
  project_root: z.string().describe("Absolute path to the RN project root"),
});

export const profilerComponentSourceTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "profiler-component-source",
  description: `AST lookup via tree-sitter: returns file path, line number, memoization status (isMemoized, hasUseCallback, hasUseMemo), and 50 lines of source for a named React component.
Call per-finding after profiler-analyze to inspect source before proposing a fix.
Returns found: false if the component is not in user-owned code (e.g. node_modules).`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(_services, params) {
    const astIndex = await buildAstIndexWithDiagnostics(params.project_root);
    const entry = astIndex.index.get(params.component_name);

    if (!entry) {
      return {
        found: false,
        component: params.component_name,
        message: `Component "${params.component_name}" not found in ${params.project_root}`,
      };
    }

    let source = "";
    try {
      const fileContent = await fs.readFile(entry.file, "utf8");
      const lines = fileContent.split("\n");
      const startLine = Math.max(0, entry.line - 1);
      const endLine = Math.min(lines.length, startLine + 50);
      source = lines.slice(startLine, endLine).join("\n");
    } catch {
      // non-fatal — file may have been renamed or deleted
    }

    return {
      found: true,
      component: params.component_name,
      file: entry.file,
      line: entry.line,
      col: entry.col,
      isMemoized: entry.isMemoized,
      hasUseCallback: entry.hasUseCallback,
      hasUseMemo: entry.hasUseMemo,
      source,
    };
  },
};
