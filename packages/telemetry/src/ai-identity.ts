// Coarse identity of the AI coding tool driving the MCP server: a canonical slug
// only. The signal is the MCP `initialize` handshake `clientInfo.name`, read via
// `Server.getClientVersion()`, plus one host env var where the name alone is too
// generic (Devin Desktop); the raw name is never recorded, so a client that
// names itself after the machine or user can't leak that string. Names we can't
// map become the coarse `other` bucket.

export const AI_CLIENTS = [
  "codex",
  "claude_code",
  "cursor",
  "gemini",
  "vscode",
  "windsurf",
  "zed",
  "opencode",
  "copilot",
  "other",
] as const;

export type AiClient = (typeof AI_CLIENTS)[number];

export type AiTelemetryProps = {
  ai_client?: AiClient;
};

// Runtime MCP `clientInfo.name` → canonical slug, matched against the trimmed,
// lower-cased name. Patterns match a tool's client identity only, never its
// server-side name (`codex-mcp-client`, not `codex-mcp-server`).
const RUNTIME_CLIENT_PATTERNS: ReadonlyArray<readonly [RegExp, AiClient]> = [
  [/^codex-mcp-client\b/, "codex"],
  [/^claude-code\b/, "claude_code"],
  [/^cursor\b/, "cursor"],
  [/^gemini-cli-mcp-client\b/, "gemini"],
  [/^visual studio code\b/, "vscode"],
  [/^code - oss\b/, "vscode"],
  [/^windsurf\b/, "windsurf"],
  [/^zed\b/, "zed"],
  [/^opencode\b/, "opencode"],
  [/^github-copilot-developer\b/, "copilot"],
];

/**
 * Pick the AI-client telemetry keys out of a wider metadata object, omitting
 * absent ones so events never carry `undefined` values.
 */
export function aiTelemetryFromMeta(meta: AiTelemetryProps): AiTelemetryProps {
  return {
    ...(meta.ai_client ? { ai_client: meta.ai_client } : {}),
  };
}

/**
 * Normalize a runtime MCP `clientInfo.name` to an {@link AiClient}. Unrecognized
 * names return `undefined`; falling back to `other` is the caller's decision.
 * `env` is the MCP server's own environment, inherited from the spawning client.
 */
export function canonicalizeAiClient(
  value: string | undefined | null,
  env: Readonly<Record<string, string | undefined>> = {}
): AiClient | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  for (const [pattern, slug] of RUNTIME_CLIENT_PATTERNS) {
    if (pattern.test(lower)) return slug;
  }
  // Devin Desktop (Windsurf, renamed) runs MCP servers through its bundled Devin
  // agent, which sends the rmcp library's default name. Only the WINDSURF_IDE_TYPE
  // its extension host sets tells it apart from the standalone Devin CLI.
  if (lower === "rmcp" && env.WINDSURF_IDE_TYPE) return "windsurf";
  return undefined;
}
