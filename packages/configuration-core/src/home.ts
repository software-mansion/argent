import * as os from "node:os";
import * as path from "node:path";

const ARGENT_HOME_DIR_ENV = "ARGENT_HOME_DIR";

/** Overrides for resolving config paths, used by tests to sandbox locations. */
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

/** The user's home directory: the base the global scope hangs off. */
export function resolveHomeDir(options: ConfigPathOptions = {}): string {
  if (options.homeDir) return options.homeDir;
  return process.platform === "win32"
    ? (nonEmpty(process.env.USERPROFILE) ?? os.homedir())
    : (nonEmpty(process.env.HOME) ?? os.homedir());
}

/**
 * Argent's global state directory: `ARGENT_HOME_DIR` when set, else
 * `~/.argent`. An explicit `homeDir` option wins over the variable.
 */
export function argentHomeDir(options: ConfigPathOptions = {}): string {
  const override = options.homeDir ? null : nonEmpty(process.env[ARGENT_HOME_DIR_ENV]);
  return override ? path.resolve(override.trim()) : path.join(resolveHomeDir(options), ".argent");
}
