import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectRoot, type FlagScope } from "./flags.js";

// Filesystem locations under the shared `~/.argent` home. These are general
// (config.json holds telemetry consent, first-run notices, Lens preferences,
// ...), so they live in configuration-core rather than any one consumer.
// Telemetry-specific paths (the identity file, the debug log) stay in
// `@argent/telemetry` and are built on top of `argentHomeDir`.

/** Overrides for resolving config paths — used by tests to sandbox locations. */
export interface ConfigPathOptions {
  /** Directory to resolve the project root from (defaults to `process.cwd()`). */
  cwd?: string;
  /** Home directory for the global scope (defaults to HOME/USERPROFILE). */
  homeDir?: string;
}

// Resolve at call time so tests can override HOME/USERPROFILE per case.
function nonEmpty(value: string | undefined): string | null {
  if (value == undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

/**
 * The user's home directory, honoring HOME (POSIX) / USERPROFILE (Windows) and
 * the test-sandbox `homeDir` override — the base the global scope hangs off.
 */
export function resolveHomeDir(options: ConfigPathOptions = {}): string {
  if (options.homeDir) return options.homeDir;
  return process.platform === "win32"
    ? (nonEmpty(process.env.USERPROFILE) ?? os.homedir())
    : (nonEmpty(process.env.HOME) ?? os.homedir());
}

/** The `~/.argent` directory, honoring HOME (POSIX) / USERPROFILE (Windows). */
export function argentHomeDir(): string {
  return path.join(resolveHomeDir(), ".argent");
}

/**
 * The `.argent` directory for a config scope. `global` is `~/.argent`; `project`
 * is `<project-root>/.argent`, where the root is resolved by walking up from
 * `cwd` for a `.argent` / `.git` / `package.json` marker (same rule as flags).
 */
export function configDir(scope: FlagScope = "global", options: ConfigPathOptions = {}): string {
  if (scope === "global") {
    return path.join(resolveHomeDir(options), ".argent");
  }
  const cwd = options.cwd ?? process.cwd();
  return path.join(resolveProjectRoot(cwd), ".argent");
}

/**
 * Shared config document for a scope. Defaults to the global
 * `~/.argent/config.json` (backward-compatible with the no-arg callers); pass
 * `"project"` for `<project-root>/.argent/config.json`. Holds several
 * independent keys — every writer must merge rather than overwrite (see
 * `updateConfig`).
 */
export function configFilePath(
  scope: FlagScope = "global",
  options: ConfigPathOptions = {}
): string {
  return path.join(configDir(scope, options), "config.json");
}
