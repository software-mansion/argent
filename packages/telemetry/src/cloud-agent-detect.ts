import { existsSync } from "node:fs";

// Fires only on a marker that distinguishes a vendor-hosted agent VM/worker from
// the same agent's local CLI. Generic CI/cloud execution stays is_ci
// (./ci-detect.ts); this names the specific agent. Matches map to a canonical
// slug, so no raw env value reaches telemetry; `env` is a parameter so tests can
// inject it.
//
// Deliberately unmatched:
//  - Codex cloud: no cloud-specific marker exists. CODEX_SANDBOX is the LOCAL
//    sandbox signal, and OpenAI declined an AGENT=codex flag (openai/codex#13416).
//  - Plain Cursor CLI (CURSOR_AGENT), local Claude Code (CLAUDE_CODE_ENTRYPOINT=
//    cli), Replit workspaces (REPL_ID without REPLIT_AGENT).

export const CLOUD_AGENT_SLUGS = [
  "claude_code",
  "cursor",
  "copilot",
  "replit",
  "devin",
  "jules",
] as const;

export type CloudAgent = (typeof CLOUD_AGENT_SLUGS)[number];

// Mirrors the Claude Code binary's own cloud check, and the entrypoints it maps
// to a `claude_code_remote` client. Local runs report entrypoint "cli",
// "claude-vscode" or "sdk-cli" and set none of these.
const CLAUDE_CLOUD_ENV_KINDS = new Set(["byoc", "anthropic_cloud"]);
const CLAUDE_REMOTE_ENTRYPOINTS = new Set([
  "remote",
  "remote_baku",
  "remote_cowork",
  "remote_desktop",
  "remote_mobile",
  "claude-in-teams",
]);

function isClaudeCodeCloud(env: NodeJS.ProcessEnv): boolean {
  const kind = env.CLAUDE_CODE_ENVIRONMENT_KIND;
  if (kind && CLAUDE_CLOUD_ENV_KINDS.has(kind)) return true;
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint && CLAUDE_REMOTE_ENTRYPOINTS.has(entrypoint)) return true;
  return Boolean(env.CLAUDE_CODE_REMOTE_SESSION_ID);
}

// The local CLI sets CURSOR_AGENT=1 and CURSOR_AGENT_CLI_LOCAL_MODE=true; cloud
// and pooled runs instead execute as a worker. Cursor's fully-managed cloud
// terminal may expose neither var, so this misses cases rather than firing on a
// local CLI run.
function isCursorCloud(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CURSOR_AGENT_WORKER_ID) || Boolean(env.CURSOR_WORKER_POOL_NAME);
}

// Runs inside GitHub Actions (so it is also is_ci) and sets no dedicated env var;
// the reliable public signal is the `copilot-swe-agent` actor / workflow identity.
// The GITHUB_ACTIONS gate stops a human user named "copilot" from tripping it.
function isCopilotAgent(env: NodeJS.ProcessEnv): boolean {
  if (!env.GITHUB_ACTIONS) return false;
  const actor = (env.GITHUB_ACTOR ?? "").toLowerCase();
  const workflowRef = (env.GITHUB_WORKFLOW_REF ?? "").toLowerCase();
  return (
    actor === "copilot" ||
    actor.includes("copilot-swe-agent") ||
    workflowRef.includes("copilot-swe-agent")
  );
}

// REPL_ID is set in ANY Repl, agent or not, so it is too broad. REPLIT_AGENT is
// the agent-specific marker (undocumented).
function isReplitAgent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.REPLIT_AGENT);
}

// Devin and Jules expose no identifying env var, only a path inside their cloud
// VM. Devin's CLI also runs locally, but /opt/.devin exists only on the cloud VM.
// The lookup is guarded so a filesystem error can never break telemetry.
const DEVIN_MARKER_PATH = "/opt/.devin";
const JULES_MARKER_PATH = "/opt/environment_summary.sh";

function safeExists(fileExists: (path: string) => boolean, path: string): boolean {
  try {
    return fileExists(path);
  } catch {
    return false;
  }
}

interface DetectCloudAgentOptions {
  /** Test seam: override the filesystem check used for the Devin/Jules markers. */
  fileExists?: (path: string) => boolean;
}

/**
 * The recognized cloud / remote AI coding-agent runtime, or `null`. Local agent
 * CLIs return `null` by design — use is_ci for generic cloud/CI execution.
 */
export function detectCloudAgent(
  env: NodeJS.ProcessEnv = process.env,
  opts: DetectCloudAgentOptions = {}
): CloudAgent | null {
  if (isClaudeCodeCloud(env)) return "claude_code";
  if (isCursorCloud(env)) return "cursor";
  if (isCopilotAgent(env)) return "copilot";
  if (isReplitAgent(env)) return "replit";

  const fileExists = opts.fileExists ?? existsSync;
  if (safeExists(fileExists, DEVIN_MARKER_PATH)) return "devin";
  if (safeExists(fileExists, JULES_MARKER_PATH)) return "jules";

  return null;
}
