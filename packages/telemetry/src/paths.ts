import * as os from "node:os";
import * as path from "node:path";

// Resolve at call time so tests can override HOME/USERPROFILE per case.
function nonEmpty(value: string | undefined): string | null {
  if (value == undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

export function argentHomeDir(): string {
  const home =
    process.platform === "win32"
      ? (nonEmpty(process.env.USERPROFILE) ?? os.homedir())
      : (nonEmpty(process.env.HOME) ?? os.homedir());
  return path.join(home, ".argent");
}

/** Anonymous identity file (UUID v4, mode 0600, atomic create). */
export function identityFilePath(): string {
  return path.join(argentHomeDir(), "telemetry-id");
}

/** Persisted opt-in / opt-out flag (JSON, "{telemetry: {enabled: boolean}}"). */
export function configFilePath(): string {
  return path.join(argentHomeDir(), "config.json");
}

/** Local payload audit log emitted when `ARGENT_TELEMETRY_DEBUG=1`. */
export function debugLogPath(): string {
  return path.join(argentHomeDir(), "telemetry-debug.log");
}
