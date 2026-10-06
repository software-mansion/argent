import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectRoot, type FlagScope } from "./flags.js";

// Filesystem locations under the shared `~/.argent` home. config.json is shared
// (telemetry consent, first-run notices, Lens preferences), so these paths live
// here rather than in any one consumer; telemetry's own paths build on
// `argentHomeDir`.

/** Overrides for resolving config paths — used by tests to sandbox locations. */
export interface ConfigPathOptions {
  /** Directory to resolve the project root from (defaults to `process.cwd()`). */
  cwd?: string;
  /** Home directory for the global scope (defaults to HOME/USERPROFILE). */
  homeDir?: string;
}

function nonEmpty(value: string | undefined): string | null {
  if (value == undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

/** The user's home directory — the base the global scope hangs off. */
export function resolveHomeDir(options: ConfigPathOptions = {}): string {
  if (options.homeDir) return options.homeDir;
  return process.platform === "win32"
    ? (nonEmpty(process.env.USERPROFILE) ?? os.homedir())
    : (nonEmpty(process.env.HOME) ?? os.homedir());
}

export function argentHomeDir(): string {
  return path.join(resolveHomeDir(), ".argent");
}

/**
 * The `.argent` directory for a scope: `~/.argent`, or `<project-root>/.argent`
 * where the root is the nearest ancestor of `cwd` holding a `.argent` / `.git` /
 * `package.json` marker (same rule as flags).
 */
export function configDir(scope: FlagScope = "global", options: ConfigPathOptions = {}): string {
  if (scope === "global") {
    return path.join(resolveHomeDir(options), ".argent");
  }
  const cwd = options.cwd ?? process.cwd();
  return path.join(resolveProjectRoot(cwd), ".argent");
}

/**
 * Shared `config.json` for a scope, global by default. Holds several independent
 * keys — every writer must merge rather than overwrite (see `updateConfig`).
 */
export function configFilePath(
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): string {
  return path.join(configDir(scope, options), "config.json");
}
