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
