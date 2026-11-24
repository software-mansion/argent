import * as path from "node:path";
import { argentHomeDir, configFilePath } from "@argent/configuration-core";

// The shared `~/.argent` paths live in `@argent/configuration-core`; re-exported
// here so telemetry's existing `./paths.js` importers keep working.
export { argentHomeDir, configFilePath };

/**
 * Telemetry identity file (mode 0600). Holds the 64-hex host fingerprint used as
 * the distinct_id, or a dashed UUID v4 when no fingerprint can be resolved.
 */
export function identityFilePath(): string {
  return path.join(argentHomeDir(), "telemetry-id");
}

/** Payload log appended when `ARGENT_TELEMETRY_DEBUG` is on. */
export function debugLogPath(): string {
  return path.join(argentHomeDir(), "telemetry-debug.log");
}
