import { z } from "zod";
import { promises as fs } from "fs";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import { buildAstIndexWithDiagnostics } from "../../../utils/react-profiler/pipeline/06-resolve/ast-index";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import { astLookupCandidates } from "../../../utils/react-profiler/component-names";

const zodSchema = z.object({
  component_name: z.string().describe("Name of the React component to look up"),
  project_root: z.string().describe("Absolute path to the RN project root"),
});

/**
 * A project tree can't ride along in a tool call, so `kind: "directory"` fails
 * a remote caller whose checkout isn't mirrored on this host, instead of
 * indexing nothing and reporting "component not found" for everything.
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "directory" },
];

export const reactProfilerComponentSourceTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "react-profiler-component-source",
  interaction: {
    startedMsg: ({ params }) => `Finding source for ${params.component_name}`,
    completedMsg: ({ params, result }) =>
      `${result.found ? "Found" : "Could not find"} source for ${params.component_name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to find source for ${params.component_name}: ${failureSignal.error_code}`,
  },
  description: `Find a React component's source via tree-sitter AST lookup: returns file path, line number, memoization status (isMemoized, hasUseCallback, hasUseMemo), and 50 lines of source for a named React component.
Call this per-finding after react-profiler-analyze to inspect source before proposing a fix.
Returns found: false if the component is not found in user-owned code (e.g. lives in node_modules).
When several files define a component with the same name (e.g. platform variants like List.tsx and List.web.tsx), returns the primary match and lists the rest under otherMatches[] (file/line/col) — check it before assuming the returned file is the one you meant.`,
  zodSchema,
  // Declared so the tool catalogue groups this with the other react-profiler-*
  // tools; the HTTP gate itself is a no-op here, as there is no device arg to
  // inspect.
  capability: RN_ONLY_TOOL_CAPABILITY,
  fileInputs,
  services: () => ({}),
  async execute(_services, params) {
    const astIndex = await buildAstIndexWithDiagnostics(params.project_root);
    // The profiler reports DevTools names (`Forget(Foo)`); the index is keyed on
    // source identifiers (`Foo`).
    const lookupKeys = astLookupCandidates(params.component_name);
    const matchedKey = lookupKeys.find((k) => astIndex.index.has(k));
    const entry = matchedKey ? astIndex.index.get(matchedKey) : undefined;

    if (!entry) {
      if (!astIndex.treeSitterAvailable) {
        return {
          found: false,
          component: params.component_name,
          message:
            `Component source lookup is unavailable: the tree-sitter parser could not be loaded, ` +
            `so no source files were indexed. Ensure @swmansion/argent's "tree-sitter" and ` +
            `"tree-sitter-typescript" dependencies are installed.`,
        };
      }
      return {
        found: false,
        component: params.component_name,
        message:
          `Component "${params.component_name}" not found in ${params.project_root} ` +
          `(searched ${astIndex.indexedFiles} files; also tried ${
            lookupKeys
              .slice(1)
              .map((k) => `"${k}"`)
              .join(", ") || "no variants"
          }).`,
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
      // file may have been renamed or deleted
    }

    return {
      found: true,
      // The key that matched, so the caller sees when a wrapped name resolved
      // through to a bare source identifier.
      component: matchedKey ?? params.component_name,
      requested: params.component_name,
      file: entry.file,
      line: entry.line,
      col: entry.col,
      isMemoized: entry.isMemoized,
      hasUseCallback: entry.hasUseCallback,
      hasUseMemo: entry.hasUseMemo,
      source,
      ...(entry.otherMatches && entry.otherMatches.length > 0
        ? { otherMatches: entry.otherMatches }
        : {}),
    };
  },
};
