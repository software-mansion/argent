import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectRoot, type FlagScope } from "./flags.js";
import { argentHomeDir, resolveHomeDir, type ConfigPathOptions } from "./home.js";

export { argentHomeDir, resolveHomeDir, type ConfigPathOptions } from "./home.js";

// Filesystem locations under the shared `~/.argent` home. config.json is shared
// (telemetry consent, first-run notices, Lens preferences), so these paths live
// here rather than in any one consumer; telemetry's own paths build on
// `argentHomeDir`.

/**
 * Whether `dir` is the home directory, by canonical path: project roots walked up
 * from `process.cwd()` are physical, while HOME may run through a symlink or
 * differ from the on-disk case.
 */
export function isHomeDir(dir: string, options: ConfigPathOptions = {}): boolean {
  return canonicalPath(dir) === canonicalPath(resolveHomeDir(options));
}

/**
 * `p` with symlinks resolved and, on case-insensitive filesystems, in its on-disk
 * case; `path.resolve(p)` when it doesn't exist.
 */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The `.argent` directory for a scope: `~/.argent`, or `<project-root>/.argent`
 * where the root is the nearest ancestor of `cwd` holding a `.argent` / `.git` /
 * `package.json` marker (same rule as flags).
 */
export function configDir(scope: FlagScope = "global", options: ConfigPathOptions = {}): string {
  if (scope === "global") return argentHomeDir(options);
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
