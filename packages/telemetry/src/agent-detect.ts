import { existsSync } from "node:fs";

// Coarse detection of an AI coding-agent runtime ("cloud agent") from the
// process environment — the agent analogue of is_ci in ./ci-detect.ts. The goal
// is the same: tag each event with *what kind of runtime emitted it* so a human
// in an editor can be told apart from an autonomous/background agent driving the
// CLI. Like is_ci, this reads only env-var NAMES (and one filesystem marker) from
// a fixed allowlist and maps a match to a canonical slug — it never copies a raw
// env value into telemetry, so a vendor that stuffs a machine/user string into
// its variable can't leak it through here.
//
// The signal table is modelled on Vercel's `@vercel/detect-agent`
// (github.com/vercel/vercel, packages/detect-agent/src/index.ts), the de-facto
// "ci-info for AI agents". We re-implement rather than depend on it for the same
// reasons ci-detect.ts re-implements ci-info: take `env` lazily so tests can
// inject it, and avoid pulling its detection at import time. Signals cross-checked
// against vendor sources where possible (see notes per entry).

export const AGENT_ENV_SLUGS = [
  "cursor",
  "claude_code",
  "codex",
  "copilot",
  "gemini",
  "replit",
  "devin",
  "antigravity",
  "augment",
  "opencode",
  "v0",
  "other",
] as const;

export type AgentEnv = (typeof AGENT_ENV_SLUGS)[number];

function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]);
}

// Vendor-specific env signals, checked in order. The first match wins.
//
// Verification notes:
//  - cursor:       CURSOR_AGENT=1 verified firsthand (running `cursor-agent -p`);
//                  CURSOR_TRACE_ID / CURSOR_EXTENSION_HOST_ROLE=agent-exec are the
//                  editor-terminal signals used by @vercel/detect-agent.
//  - claude_code:  CLAUDECODE=1 + CLAUDE_CODE_ENTRYPOINT verified firsthand and
//                  documented at code.claude.com/docs/en/env-vars.
//  - codex:        CODEX_SANDBOX (=seatbelt) / CODEX_SANDBOX_NETWORK_DISABLED are
//                  stable contracts in openai/codex (AGENTS.md, core/src/spawn.rs);
//                  CODEX_CI / CODEX_THREAD_ID per @vercel/detect-agent.
//  - copilot:      Copilot CLI config vars (docs.github.com copilot-cli-reference).
//                  The autonomous coding agent runs inside GitHub Actions and has
//                  no dedicated var — it falls under is_ci instead.
//  - others:       GEMINI_CLI, REPL_ID, ANTIGRAVITY_AGENT, AUGMENT_AGENT,
//                  OPENCODE_CLIENT per @vercel/detect-agent.
const ENV_SIGNALS: ReadonlyArray<readonly [AgentEnv, (env: NodeJS.ProcessEnv) => boolean]> = [
  [
    "cursor",
    (e) =>
      has(e, "CURSOR_AGENT") ||
      has(e, "CURSOR_TRACE_ID") ||
      e.CURSOR_EXTENSION_HOST_ROLE === "agent-exec",
  ],
  ["claude_code", (e) => has(e, "CLAUDECODE") || has(e, "CLAUDE_CODE")],
  ["codex", (e) => has(e, "CODEX_SANDBOX") || has(e, "CODEX_CI") || has(e, "CODEX_THREAD_ID")],
  [
    "copilot",
    (e) => has(e, "COPILOT_MODEL") || has(e, "COPILOT_ALLOW_ALL") || has(e, "COPILOT_GITHUB_TOKEN"),
  ],
  ["gemini", (e) => has(e, "GEMINI_CLI")],
  ["replit", (e) => has(e, "REPL_ID")],
  ["antigravity", (e) => has(e, "ANTIGRAVITY_AGENT")],
  ["augment", (e) => has(e, "AUGMENT_AGENT")],
  ["opencode", (e) => has(e, "OPENCODE_CLIENT")],
];

// Maps a non-empty cross-vendor `AI_AGENT` value to a slug. This is the emerging
// opt-in convention (also from @vercel/detect-agent). It is checked only AFTER the
// vendor-specific signals above: `AI_AGENT` is inheritable and was observed
// leaking from a parent process into an unrelated child (a Claude-Code-set
// `AI_AGENT=claude-code_...` was still present inside a spawned `cursor-agent`),
// so a more specific signal must take precedence. Unrecognized non-empty values
// bucket to "other" — the raw string is never emitted.
function fromAiAgentVar(value: string | undefined): AgentEnv | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("github-copilot") || v.includes("copilot")) return "copilot";
  if (v.includes("claude-code") || v.includes("claude_code")) return "claude_code";
  if (v.includes("cursor")) return "cursor";
  if (v.includes("codex")) return "codex";
  if (v.includes("gemini")) return "gemini";
  if (v === "v0") return "v0";
  return "other";
}

// Devin exposes no env var; its only documented marker is a filesystem path
// inside the VM (@vercel/detect-agent: DEVIN_LOCAL_PATH='/opt/.devin'). The check
// is injectable so tests don't touch the real filesystem, and guarded so a
// permission error can never break telemetry.
const DEVIN_MARKER_PATH = "/opt/.devin";

function devinMarkerExists(fileExists: (path: string) => boolean): boolean {
  try {
    return fileExists(DEVIN_MARKER_PATH);
  } catch {
    return false;
  }
}

export interface DetectAgentOptions {
  /** Test seam: override the filesystem check used for the Devin marker. */
  fileExists?: (path: string) => boolean;
}

/**
 * Detect the AI coding-agent runtime the current process is executing under, or
 * `null` if none is recognized. Vendor-specific env signals take precedence over
 * the generic, inheritable `AI_AGENT` convention; the Devin filesystem marker is
 * checked last.
 */
export function detectAgentEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: DetectAgentOptions = {}
): AgentEnv | null {
  for (const [slug, test] of ENV_SIGNALS) {
    if (test(env)) return slug;
  }

  const fromAiAgent = fromAiAgentVar(env.AI_AGENT);
  if (fromAiAgent) return fromAiAgent;

  if (devinMarkerExists(opts.fileExists ?? existsSync)) return "devin";

  return null;
}
