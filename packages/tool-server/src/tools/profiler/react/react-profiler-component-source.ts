import { z } from "zod";
import { promises as fs } from "fs";
import type { ToolDefinition } from "@argent/registry";
import { REACT_PROFILER_SESSION_NAMESPACE } from "../../../blueprints/react-profiler-session";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  component_name: z.string().describe("Name of the React component to look up"),
  project_root: z.string().describe("Absolute path to the RN project root"),
});

export const reactProfilerComponentSourceTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-component-source",
  description: `Inspect the source of a React component via AST lookup using tree-sitter. Use when react-profiler-analyze identifies a hot component and you need to see its implementation, e.g. component_name "FeedItem". Parameters: component_name, port, and project_root. Returns file path, line number, memoization status (isMemoized, hasUseCallback, hasUseMemo), and 50 lines of source. Returns found: false if component is not in user-owned code (e.g. node_modules). Fails if project_root is invalid.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
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
