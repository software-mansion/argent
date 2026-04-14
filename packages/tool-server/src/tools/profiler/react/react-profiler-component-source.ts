import { z } from "zod";
import { promises as fs } from "fs";
import type { ToolDefinition } from "@argent/registry";
import { REACT_PROFILER_SESSION_NAMESPACE } from "../../../blueprints/react-profiler-session";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { requireProjectRoot } from "../../../request-context";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  component_name: z.string().describe("Name of the React component to look up"),
});

export const reactProfilerComponentSourceTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-component-source",
  description: `Find a React component's source via tree-sitter AST lookup: returns file path, line number, memoization status (isMemoized, hasUseCallback, hasUseMemo), and 50 lines of source for a named React component.
Call this per-finding after react-profiler-analyze to inspect source before proposing a fix.
Returns found: false if the component is not found in user-owned code (e.g. lives in node_modules).`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(_services, params) {
    const projectRoot = requireProjectRoot();
    const astIndex = await buildAstIndexWithDiagnostics(projectRoot);
    const entry = astIndex.index.get(params.component_name);

    if (!entry) {
      return {
        found: false,
        component: params.component_name,
        message: `Component "${params.component_name}" not found in ${projectRoot}`,
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
