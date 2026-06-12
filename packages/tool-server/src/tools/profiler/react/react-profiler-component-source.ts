import { z } from "zod";
import { promises as fs } from "fs";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";

const zodSchema = z.object({
  component_name: z.string().describe("Name of the React component to look up"),
  project_root: z.string().describe("Absolute path to the RN project root"),
});

/**
 * The AST lookup scans the whole project tree, which can't ride along in a
 * tool call — so the boundary gates on the directory existing on this host. A
 * remote caller whose checkout isn't mirrored here gets an actionable error
 * instead of a silent empty index ("component not found" for everything).
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "directory" },
];

export const reactProfilerComponentSourceTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-component-source",
  description: `Find a React component's source via tree-sitter AST lookup: returns file path, line number, memoization status (isMemoized, hasUseCallback, hasUseMemo), and 50 lines of source for a named React component.
Call this per-finding after react-profiler-analyze to inspect source before proposing a fix.
Returns found: false if the component is not found in user-owned code (e.g. lives in node_modules).`,
  zodSchema,
  // Companion to react-profiler-analyze. Carries the same RN-only capability
  // declaration as the rest of react-profiler-* for intent-clarity, even
  // though the HTTP gate is a no-op here (the tool takes no device_id, so
  // there's nothing for the gate to inspect). An LLM agent reading the tool
  // catalogue should see this is paired with the other react-profiler tools
  // and not reach for it on an Electron app.
  capability: RN_ONLY_TOOL_CAPABILITY,
  fileInputs,
  services: () => ({}),
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
