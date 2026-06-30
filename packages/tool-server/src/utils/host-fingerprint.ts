import { execFileSync } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// `simulator-server fingerprint` is fast, but cap it so a wedged binary can't
// block the first telemetry event indefinitely.
const FINGERPRINT_TIMEOUT_MS = 5_000;

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`.
 *
 * Injected into telemetry (which is a dependency leaf and must not reach for
 * the simulator-server binary itself) so it can derive a stable per-machine
 * `distinct_id`. Best-effort: returns null — never throws — when the binary is
 * absent or the command fails, so telemetry falls back to a random id.
 */
export function resolveHostFingerprint(): string | null {
  try {
    const out = execFileSync(simulatorServerBinaryPath(), ["fingerprint"], {
      encoding: "utf8",
      timeout: FINGERPRINT_TIMEOUT_MS,
      // Ignore stderr so a binary that logs diagnostics doesn't pollute the
      // tool-server's stderr; stdout (index 1) is captured as the return value.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
