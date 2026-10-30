/**
 * Former tool ids, each mapped to the id the tool has now. The tools declare
 * the same names in `ToolDefinition.aliases`, which is what the registry
 * dispatches on; this copy serves the code that compares tool ids without a
 * registry at hand: `tool:` steps in saved YAML, the tools client, the MCP
 * adapter.
 */
export const TOOL_ID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "flow-start-recording": "e2e-start-recording",
  "flow-add-step": "e2e-add-step",
  "flow-add-echo": "e2e-add-echo",
  "flow-add-script": "e2e-add-script",
  "flow-finish-recording": "e2e-finish-recording",
  "flow-read-prerequisite": "e2e-read-prerequisite",
  "flow-execute": "e2e-execute",
});

/** The current id of a tool named by a former id; any other id unchanged. */
export function canonicalToolId(id: string): string {
  return Object.hasOwn(TOOL_ID_ALIASES, id) ? TOOL_ID_ALIASES[id]! : id;
}

/**
 * Former param names, by the current id of the tool that takes them, each
 * mapped to the name the param has now. Every entry point of a call renames
 * them ({@link canonicalToolArgs}), so a call, a `tool:` step in saved YAML
 * and an older client may still use a former name.
 */
export const TOOL_PARAM_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    "e2e-execute": Object.freeze({ flow_path: "e2e_test_path", flow_file: "e2e_test_file" }),
    "e2e-read-prerequisite": Object.freeze({
      flow_path: "e2e_test_path",
      flow_file: "e2e_test_file",
    }),
  });

/** A call that sets a param under both its former and its current name. */
export class ToolParamAliasError extends Error {
  constructor(former: string, current: string) {
    super(`Pass ${current} or its former name ${former}, not both.`);
    this.name = "ToolParamAliasError";
  }
}

/** The former param names of a tool named by any id, mapped to the current ones. */
export function toolParamAliases(tool: string): Readonly<Record<string, string>> {
  const id = canonicalToolId(tool);
  return Object.hasOwn(TOOL_PARAM_ALIASES, id) ? TOOL_PARAM_ALIASES[id]! : {};
}

/**
 * `args` of `tool` with each former param name renamed to the current one; any
 * other value unchanged. Throws {@link ToolParamAliasError} when both names are set.
 */
export function canonicalToolArgs<T>(tool: string, args: T): T {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const [former, current] of Object.entries(toolParamAliases(tool))) {
    if (record[former] === undefined) continue;
    if (record[current] !== undefined) throw new ToolParamAliasError(former, current);
    out ??= { ...record };
    out[current] = out[former];
    delete out[former];
  }
  return (out ?? args) as T;
}
