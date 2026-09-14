/**
 * Registry of the coding-agent CLIs `argent lens` can bind to: how to detect
 * each on PATH and how to launch it.
 */

import { execFileSync } from "node:child_process";

export interface AgentSpec {
  /** Stable id used by `--agent` and the picker. */
  id: string;
  /** Human label shown in the picker. */
  displayName: string;
  /** Executable looked up on PATH. */
  bin: string;
  /**
   * Shell command to run in the agent's terminal. `cwdQuoted` and `seedQuoted`
   * are ALREADY shell-quoted by the caller; `seedQuoted` is the path to the
   * seed file, and is unused in inject mode.
   */
  launch: (cwdQuoted: string, seedQuoted: string) => string;
  /** The CLI has no initial-prompt arg — type the seed in after the TUI boots. */
  injectSeed?: boolean;
}

/** Supported agents, in the order the picker lists them. */
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

export function findAgentById(id: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function agentIds(): string[] {
  return AGENTS.map((a) => a.id);
}

/** `which`/`where` exits non-zero when the binary is absent. */
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

export function isAgentInstalled(agent: AgentSpec, isOnPath = defaultIsOnPath): boolean {
  return isOnPath(agent.bin);
}

export function detectInstalledAgents(isOnPath = defaultIsOnPath): AgentSpec[] {
  return AGENTS.filter((a) => isOnPath(a.bin));
}
