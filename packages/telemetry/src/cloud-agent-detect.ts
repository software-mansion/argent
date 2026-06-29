import { existsSync } from "node:fs";

// Detects whether the process is running inside a *cloud / remote* AI coding-agent
// environment — a vendor-hosted VM or worker driving the work autonomously — as
// opposed to a human running an agent CLI locally. This is a deliberately narrow,
// high-confidence signal: it fires only when we have a marker that genuinely
// distinguishes the remote/cloud runtime, never merely "an agent CLI is present".
// It is the agent-environment analogue of is_ci (./ci-detect.ts) and complements
// it — generic CI/cloud execution stays is_ci; this names the specific agent.
//
// Like is_ci, it reads only a fixed allowlist of env-var NAMES (plus two
// filesystem markers) and maps a match to a canonical slug — a raw env value is
// never copied into telemetry. `env` is taken lazily so tests can inject it.
//
// Markers were chosen to exclude local CLI use. Notably excluded:
//  - Codex cloud: no reliable cloud-specific marker exists. CODEX_SANDBOX is the
//    LOCAL sandbox signal, and OpenAI declined to add an AGENT=codex flag
//    (openai/codex#13416). Codex cloud is therefore not detected here.
//  - Plain Cursor CLI (CURSOR_AGENT), local Claude Code (CLAUDE_CODE_ENTRYPOINT=
//    cli), Replit *workspaces* (REPL_ID without REPLIT_AGENT): all local/non-agent
//    and intentionally not matched.

export const CLOUD_AGENT_SLUGS = [
  "claude_code",
  "cursor",
  "copilot",
  "replit",
  "devin",
  "jules",
] as const;

export type CloudAgent = (typeof CLOUD_AGENT_SLUGS)[number];

// --- Claude Code (remote / cloud) ---------------------------------------------
// Verified firsthand against the Claude Code binary, which carries an internal
// cloud check `CLAUDE_CODE_ENVIRONMENT_KIND === "byoc" || "anthropic_cloud"` and
// maps these entrypoints to a `claude_code_remote` client. Local runs report
// entrypoint "cli" / "claude-vscode" / "sdk-cli" and set none of these.
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

// --- Cursor (background / worker, not local CLI) ------------------------------
// The local CLI sets CURSOR_AGENT=1 and CURSOR_AGENT_CLI_LOCAL_MODE=true; cloud /
// pooled execution instead runs as a *worker*. cursor-agent reads
// CURSOR_AGENT_WORKER_ID from the env (verified firsthand), and the worker-pool
// vars come from Cursor's own cookbook entrypoint. Cursor's fully-managed cloud
// terminal may not always expose these, so this is best-effort but never a false
// positive on a local CLI run.
function isCursorCloud(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CURSOR_AGENT_WORKER_ID) || Boolean(env.CURSOR_WORKER_POOL_NAME);
}

// --- GitHub Copilot coding agent ----------------------------------------------
// Runs inside GitHub Actions (so it is also is_ci). It sets no dedicated env var;
// the public, reliable signal is the actor / workflow identity
// `copilot-swe-agent`. Gated on GITHUB_ACTIONS so a developer who merely happens
// to be named "copilot" can't trip it.
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

// --- Replit Agent (not a plain Repl workspace) --------------------------------
// REPL_ID is set in ANY Repl, agent or not, so it is too broad. REPLIT_AGENT=1 is
// the agent-specific marker (undocumented but consistently used as such).
function isReplitAgent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.REPLIT_AGENT);
}

// --- Filesystem-only markers (Devin, Jules) -----------------------------------
// Neither exposes an identifying env var; each leaves a vendor-specific path in
// its cloud VM. Devin's CLI now also runs locally, but /opt/.devin marks only the
// cloud VM. The check is injectable for tests and guarded so a permission error
// can never break telemetry.
const DEVIN_MARKER_PATH = "/opt/.devin";
const JULES_MARKER_PATH = "/opt/environment_summary.sh";

function safeExists(fileExists: (path: string) => boolean, path: string): boolean {
  try {
    return fileExists(path);
  } catch {
    return false;
  }
}

export interface DetectCloudAgentOptions {
  /** Test seam: override the filesystem check used for the Devin/Jules markers. */
  fileExists?: (path: string) => boolean;
}

/**
 * Detect the cloud / remote AI coding-agent runtime the process is executing
 * under, or `null` if it is not in (a recognized) one. Local agent CLIs return
 * `null` by design — use is_ci for generic cloud/CI execution.
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
