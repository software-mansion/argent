import type { ToolMeta } from "@argent/tools-client";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object" } & Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * Maps a tool-server `ToolMeta` entry to the MCP `tools/list` shape, forwarding
 * `alwaysLoad` and `searchHint` as `_meta["anthropic/alwaysLoad"]` /
 * `_meta["anthropic/searchHint"]` so Claude Code can opt tools out of
 * progressive tool loading and rank them via the ToolSearch BM25 index.
 * `_meta` is omitted entirely when neither hint is present, so older clients
 * that don't understand it see byte-identical responses.
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
