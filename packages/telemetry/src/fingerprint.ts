import { execFileSync } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// `simulator-server fingerprint` just reads host hardware ids, so it is fast.
// It runs synchronously and only once per process (the id is memoized in
// identity.ts), so cap it tightly: a wedged binary must not stall a CLI command
// or the tool-server's event loop. A too-low cap only costs a fallback to a
// random id, never a repeated stall.
const FINGERPRINT_TIMEOUT_MS = 2_000;

/**
 * Resolve the host machine fingerprint via `simulator-server fingerprint`.
 *
 * Used to derive a stable per-machine `distinct_id`. Best-effort: returns null
 * — never throws — when the binary is absent or the command fails, so identity
 * falls back to a random id. Resolved once per process, lazily, on the first
 * tracked event, for every Argent entry point (installer / CLI / tool-server /
 * MCP) — so the id is stable across uninstall + reinstall, not only for the
 * tool-server.
 */
export function resolveHostFingerprint(): string | null {
  try {
    const out = execFileSync(simulatorServerBinaryPath(), ["fingerprint"], {
      encoding: "utf8",
      timeout: FINGERPRINT_TIMEOUT_MS,
      // Ignore stderr so a binary that logs diagnostics doesn't pollute the
      // caller's stderr; stdout (index 1) is captured as the return value.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
