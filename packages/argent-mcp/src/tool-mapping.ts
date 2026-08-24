import type { ToolMeta } from "@argent/tools-client";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object" } & Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * Maps a tool-server `ToolMeta` to the MCP `tools/list` shape. `alwaysLoad` opts the
 * tool out of Claude Code's progressive tool loading; `searchHint` feeds its ToolSearch
 * BM25 ranker.
 */
export function toMcpTool(t: ToolMeta): McpTool {
  const meta: Record<string, unknown> = {};
  if (t.alwaysLoad) meta["anthropic/alwaysLoad"] = true;
  if (t.searchHint) meta["anthropic/searchHint"] = t.searchHint;
  return {
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", ...t.inputSchema },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}
