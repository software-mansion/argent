import * as path from "node:path";
import { argentHomeDir, configFilePath } from "@argent/configuration-core";

// `argentHomeDir` and `configFilePath` (the shared `~/.argent` home and
// config.json) now live in `@argent/configuration-core` — they are general,
// not telemetry-specific. Re-export them here so the telemetry modules that
// already import from `./paths.js` keep working unchanged.
export { argentHomeDir, configFilePath };

/** Anonymous identity file (UUID v4, mode 0600, atomic create). */
export function identityFilePath(): string {
  return path.join(argentHomeDir(), "telemetry-id");
}

/** Local payload audit log emitted when `ARGENT_TELEMETRY_DEBUG=1`. */
export function debugLogPath(): string {
  return path.join(argentHomeDir(), "telemetry-debug.log");
}
