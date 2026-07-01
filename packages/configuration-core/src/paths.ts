import * as os from "node:os";
import * as path from "node:path";

// Filesystem locations under the shared `~/.argent` home. These are general
// (config.json holds telemetry consent, first-run notices, Lens preferences,
// ...), so they live in configuration-core rather than any one consumer.
// Telemetry-specific paths (the identity file, the debug log) stay in
// `@argent/telemetry` and are built on top of `argentHomeDir`.

// Resolve at call time so tests can override HOME/USERPROFILE per case.
function nonEmpty(value: string | undefined): string | null {
  if (value == undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

/** The `~/.argent` directory, honoring HOME (POSIX) / USERPROFILE (Windows). */
export function argentHomeDir(): string {
  const home =
    process.platform === "win32"
      ? (nonEmpty(process.env.USERPROFILE) ?? os.homedir())
      : (nonEmpty(process.env.HOME) ?? os.homedir());
  return path.join(home, ".argent");
}

/** Shared config document (`~/.argent/config.json`). Holds several independent
 * keys — every writer must merge rather than overwrite (see `updateConfig`). */
export function configFilePath(): string {
  return path.join(argentHomeDir(), "config.json");
}
