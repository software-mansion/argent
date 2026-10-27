import type { ToolMeta } from "@argent/tools-client";

type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object" } & Record<string, unknown>;
  annotations?: { readOnlyHint: true };
  _meta?: Record<string, unknown>;
};

/**
 * The schema without its retired params (`z.never()`, serialized as an untyped
 * `not: {}`). Grammar-constrained providers refuse an untyped param, which fails
 * the whole request (#1250); the tool-server still refuses the key with guidance.
 */
function withoutRetiredParams(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, { not?: object }> | undefined;
  if (!properties) return schema;
  const live = Object.entries(properties).filter(
    ([, prop]) => !prop.not || Object.keys(prop.not).length > 0
  );
  if (live.length === Object.keys(properties).length) return schema;
  return { ...schema, properties: Object.fromEntries(live) };
}

/**
 * Maps a tool-server `ToolMeta` to the MCP `tools/list` shape. `alwaysLoad` opts the
 * tool out of Claude Code's progressive tool loading; `searchHint` feeds its ToolSearch
 * BM25 ranker. `readOnly` becomes the `readOnlyHint` annotation, which lets Claude Code
 * run the tool without a prompt in plan mode.
 */
export function toMcpTool(t: ToolMeta): McpTool {
  const meta: Record<string, unknown> = {};
  if (t.alwaysLoad) meta["anthropic/alwaysLoad"] = true;
  if (t.searchHint) meta["anthropic/searchHint"] = t.searchHint;
  return {
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", ...withoutRetiredParams(t.inputSchema) },
    ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/** The MCP `tools/list` payload: every tool but those marked `hideFromMcp`. */
export function toMcpToolList(tools: ToolMeta[]): McpTool[] {
  return tools.filter((t) => !t.hideFromMcp).map(toMcpTool);
}
