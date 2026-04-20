import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDependency } from "@argent/registry";

const execFileAsync = promisify(execFile);

/**
 * Thrown when a tool declares a host-binary dependency (e.g. `adb`, `xcrun`)
 * that is not on PATH. The HTTP dispatcher maps this to `424 Failed
 * Dependency` with the message as the body; `.message` is the human-friendly
 * install hint, safe to bubble straight to the agent.
 */
export class DependencyMissingError extends Error {
  readonly missing: ToolDependency[];
  constructor(missing: ToolDependency[], message: string) {
    super(message);
    this.name = "DependencyMissingError";
    this.missing = missing;
  }
}

// Cache for CACHE_TTL_MS so a burst of tool calls pays at most one `command -v`
// per dep, but an install mid-session (e.g. the user runs `xcode-select
// --install` after a missing-dep error) recovers on its own within a minute
// without needing a tool-server restart.
const CACHE_TTL_MS = 60_000;
type CacheEntry = { available: boolean; checkedAt: number };
const cache = new Map<ToolDependency, CacheEntry>();

// Short per-dep hints — the message is what the LLM sees on a missing-dep
// error, so it should tell it how to unblock the user.
const INSTALL_HINTS: Record<ToolDependency, string> = {
  xcrun:
    "Xcode command-line tools are not installed. Run `xcode-select --install` (or install Xcode from the App Store) and retry. Only required for iOS simulators.",
  adb: "Android SDK Platform Tools are not installed (`adb` not on PATH). Install with `brew install --cask android-platform-tools` or via Android Studio → SDK Manager, then retry. Only required for Android devices and emulators.",
};

async function probe(dep: ToolDependency): Promise<boolean> {
  try {
    // `command -v` via `/bin/sh` is POSIX-portable and doesn't invoke the dep
    // itself — a bare `adb` or `xcrun` call would fork the tool just to check
    // existence, which is both slower and (for xcrun) can prompt the license
    // agreement dialog on first use.
    await execFileAsync("/bin/sh", ["-c", `command -v ${dep}`], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function isAvailable(dep: ToolDependency): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(dep);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.available;
  const available = await probe(dep);
  cache.set(dep, { available, checkedAt: now });
  return available;
}

/**
 * Throws DependencyMissingError if any declared dep isn't on PATH. All deps
 * are probed in parallel; the error message lists every missing one so the
 * agent sees the complete picture on the first failure instead of being
 * prompted twice for the same tool.
 */
export async function ensureDeps(deps: readonly ToolDependency[]): Promise<void> {
  if (deps.length === 0) return;
  const results = await Promise.all(deps.map(async (d) => [d, await isAvailable(d)] as const));
  const missing = results.filter(([, ok]) => !ok).map(([d]) => d);
  if (missing.length === 0) return;
  const message = missing.map((d) => INSTALL_HINTS[d]).join(" ");
  throw new DependencyMissingError(missing, message);
}

/**
 * Single-dep helper for cross-platform tools that branch on `classifyDevice`:
 * the static `requires` field can't express "adb OR xcrun depending on
 * target", so these tools call `ensureDep('xcrun' | 'adb')` right after they
 * know which platform the udid resolved to.
 */
export async function ensureDep(dep: ToolDependency): Promise<void> {
  return ensureDeps([dep]);
}

/** Test-only: clear the availability cache between tests. */
export function __resetDepCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only: pre-populate the cache so `ensureDep(dep)` is a no-op without
 * shelling out. Needed by tool dispatch tests that assert on `execFile` call
 * shapes / counts — without this, the `command -v <dep>` probe appears as an
 * extra first call and breaks `mock.calls[0]` expectations.
 */
export function __primeDepCacheForTests(deps: ToolDependency[]): void {
  const now = Date.now();
  for (const d of deps) cache.set(d, { available: true, checkedAt: now });
}
