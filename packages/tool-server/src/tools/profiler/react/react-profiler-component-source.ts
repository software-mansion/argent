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
  description: `Find a React component's source file, line number, memoization status, and 50 lines of code via AST analysis.
Use when react-profiler-analyze identifies a slow component and you want to inspect its implementation before proposing a fix.

Parameters: port — Metro TCP port (default 8081); component_name — React component name (e.g. "ProductList"); project_root — absolute path to the RN project root (e.g. /Users/dev/MyApp).
Example: { "port": 8081, "component_name": "ProductList", "project_root": "/Users/dev/MyApp" }
Returns { found: true, filePath, line, isMemoized, hasUseCallback, hasUseMemo, source } or { found: false } if the component is in node_modules or cannot be located. Fails if project_root does not exist.`,
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
