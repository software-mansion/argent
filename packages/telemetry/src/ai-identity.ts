// Coarse identity of the AI coding tool driving the MCP server. We record only
// a canonical client slug (which tool) — never prompts, model output, or args.
//
// The single signal is the MCP `initialize` handshake `clientInfo.name` (ground
// truth of what is actually connecting), read at runtime via
// `Server.getClientVersion()`. Anything we can't map is reported as the coarse
// `other` bucket — we never capture the raw client name, so a non-standard
// client that names itself after the machine or user can't leak that string.

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

// Runtime MCP `clientInfo.name` → canonical slug. Patterns are tested against the
// trimmed, lower-cased name. Each is verified against the tool's source; we match
// the CLIENT identity precisely so decoys are excluded
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
 * Pick out only the AI-client telemetry keys from a wider metadata object,
 * omitting any that are absent so events never carry `undefined` values. Shared
 * by every emitter so the spread shape stays identical across call sites.
 */
export function aiTelemetryFromMeta(meta: AiTelemetryProps): AiTelemetryProps {
  return {
    ...(meta.ai_client ? { ai_client: meta.ai_client } : {}),
  };
}

/**
 * Normalize a runtime MCP `clientInfo.name` to an {@link AiClient}. Returns
 * `undefined` for anything unrecognized (callers may then fall back to the
 * coarse `other` bucket).
 */
export function canonicalizeAiClient(value: string | undefined | null): AiClient | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  for (const [pattern, slug] of RUNTIME_CLIENT_PATTERNS) {
    if (pattern.test(lower)) return slug;
  }
  return undefined;
}
