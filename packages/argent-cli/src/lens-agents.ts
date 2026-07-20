/**
 * The coding-agent CLIs `argent lens` can bind to. Lens spawns and owns exactly
 * one agent terminal; this registry says which CLIs are supported, how to detect
 * them on PATH, and how to launch each one seeded with the CLI-Lens prompt.
 *
 * Two seeding styles:
 *  - arg mode (most CLIs): the seed is passed as the initial-prompt argument, so
 *    the agent reads it the moment it boots (`claude "<seed>"`, `gemini -i …`).
 *  - inject mode (`injectSeed`): the CLI's interactive TUI takes no prompt arg
 *    (e.g. opencode), so lens launches the bare TUI and types the seed in as the
 *    first message once it's up — the same channel the feedback relay uses.
 *
 * Only CLI agents for now; GUI/editor integrations may come later.
 */

import { execFileSync } from "node:child_process";

export interface AgentSpec {
  /** Stable id used by `--agent` and in messages. */
  id: string;
  /** Human label shown in the picker. */
  displayName: string;
  /** Executable looked up on PATH (also what gets spawned). */
  bin: string;
  /**
   * Build the shell command run in the spawned terminal's interactive shell.
   * `cwdQuoted` and `seedQuoted` are ALREADY shell-quoted by the caller. In
   * inject mode `seedQuoted` is unused (the seed is typed in after boot).
   */
  launch: (cwdQuoted: string, seedQuoted: string) => string;
  /** The CLI has no initial-prompt arg — type the seed in after the TUI boots. */
  injectSeed?: boolean;
}

/**
 * Supported agents, in preference order (the picker's default is the first
 * installed one). `claude "<seed>"`, `codex "<seed>"`, and `cursor-agent
 * "<seed>"` all forward the positional to their interactive session; gemini uses
 * `-i` ("execute this prompt then stay interactive"); opencode's TUI takes only a
 * project path, so it's seeded by injection.
 */
export const AGENTS: readonly AgentSpec[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    bin: "claude",
    launch: (cwd, seed) => `cd ${cwd} 2>/dev/null; claude "$(cat ${seed})"`,
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    bin: "codex",
    launch: (cwd, seed) => `cd ${cwd} 2>/dev/null; codex "$(cat ${seed})"`,
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    bin: "gemini",
    launch: (cwd, seed) => `cd ${cwd} 2>/dev/null; gemini -i "$(cat ${seed})"`,
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    bin: "opencode",
    launch: (cwd) => `cd ${cwd} 2>/dev/null; opencode`,
    injectSeed: true,
  },
  {
    id: "cursor",
    displayName: "Cursor CLI",
    bin: "cursor-agent",
    launch: (cwd, seed) => `cd ${cwd} 2>/dev/null; cursor-agent "$(cat ${seed})"`,
  },
];

/** Look up an agent by its id. */
export function findAgentById(id: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** All known agent ids — for help text and `--agent` validation messages. */
export function agentIds(): string[] {
  return AGENTS.map((a) => a.id);
}

/** Default PATH probe: `which`/`where` exits non-zero when the binary is absent. */
function defaultIsOnPath(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether an agent's binary is installed (on PATH). */
export function isAgentInstalled(agent: AgentSpec, isOnPath = defaultIsOnPath): boolean {
  return isOnPath(agent.bin);
}

/** The supported agents currently installed on PATH, in preference order. */
export function detectInstalledAgents(isOnPath = defaultIsOnPath): AgentSpec[] {
  return AGENTS.filter((a) => isOnPath(a.bin));
}
