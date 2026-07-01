import { execFileSync } from "node:child_process";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

// `simulator-server fingerprint` just reads host hardware ids and is fast once
// warm (<100ms). It runs synchronously and only once per process (the id is
// memoized in identity.ts). The cap must be generous enough that the FIRST run
// on a fresh machine still resolves — e.g. the binary's first execution right
// after `argent install`, where macOS Gatekeeper assessment of the freshly
// written binary can add a one-time delay. Timing out there would fall back to
// a random id for that process's events (until a later run migrates), so we err
// toward resolving; the cap only exists to bound a genuinely wedged binary.
const FINGERPRINT_TIMEOUT_MS = 5_000;

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
