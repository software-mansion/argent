import { execFileSync } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// `simulator-server fingerprint` just reads host hardware ids, so it is fast
// (and the binary is already warm — the simulator watcher spawns it at startup
// before the first telemetry event). It runs synchronously on the event loop,
// so cap it tightly: a wedged binary must not stall request handling, and the
// resolver runs at most once per process so a too-low cap only costs a fallback
// to a random id, never a repeated stall.
const FINGERPRINT_TIMEOUT_MS = 2_000;

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
