import * as path from "node:path";
import { argentHomeDir, configFilePath } from "@argent/configuration-core";

// `argentHomeDir` and `configFilePath` (the shared `~/.argent` home and
// config.json) now live in `@argent/configuration-core` — they are general,
// not telemetry-specific. Re-export them here so the telemetry modules that
// already import from `./paths.js` keep working unchanged.
export { argentHomeDir, configFilePath };

/**
 * Telemetry identity file (mode 0600, atomic create). In steady state it holds
 * the 64-hex host fingerprint (a one-way hash of stable hardware ids) used as
 * the telemetry distinct_id; a dashed random UUID v4 is only the fallback shape
 * kept when the fingerprint can't be resolved.
 */
export function identityFilePath(): string {
  return path.join(argentHomeDir(), "telemetry-id");
}

/** Local payload audit log emitted when `ARGENT_TELEMETRY_DEBUG=1`. */
export function debugLogPath(): string {
  return path.join(argentHomeDir(), "telemetry-debug.log");
}
