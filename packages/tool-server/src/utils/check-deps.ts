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

const CACHE_TTL_MS = 60_000;
type CacheEntry = { available: boolean; checkedAt: number };
const cache = new Map<ToolDependency, CacheEntry>();

const INSTALL_HINTS: Record<ToolDependency, string> = {
  xcrun:
    "Xcode command-line tools are not installed. Run `xcode-select --install` (or install Xcode from the App Store) and retry. Only required for iOS simulators.",
  adb: "Android SDK Platform Tools are not installed (`adb` not on PATH). Install with `brew install --cask android-platform-tools` or via Android Studio → SDK Manager, then retry. Only required for Android devices and emulators.",
};

async function probe(dep: ToolDependency): Promise<boolean> {
  try {
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
 * agent sees the complete picture on the first failure.
 */
export async function ensureDeps(deps: readonly ToolDependency[]): Promise<void> {
  if (deps.length === 0) return;
  const results = await Promise.all(deps.map(async (d) => [d, await isAvailable(d)] as const));
  const missing = results.filter(([, ok]) => !ok).map(([d]) => d);
  if (missing.length === 0) return;
  const message = missing.map((d) => INSTALL_HINTS[d]).join(" ");
  throw new DependencyMissingError(missing, message);
}

/** Single-dep helper for tools that branch on `classifyDevice`. */
export async function ensureDep(dep: ToolDependency): Promise<void> {
  return ensureDeps([dep]);
}

/** Test-only: clear the cache. */
export function __resetDepCacheForTests(): void {
  cache.clear();
}

/** Test-only: pre-populate the cache so probe() is a no-op. */
export function __primeDepCacheForTests(deps: ToolDependency[]): void {
  const now = Date.now();
  for (const d of deps) cache.set(d, { available: true, checkedAt: now });
}
