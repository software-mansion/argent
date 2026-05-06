import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDependency } from "@argent/registry";
import { resolveAndroidBinary } from "./android-binary";

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
  adb: "Android SDK Platform Tools not found. Install with `brew install --cask android-platform-tools` or via Android Studio → SDK Manager. If installed, ensure `adb` is on PATH or set `$ANDROID_HOME` to the SDK root (the resolver checks `$ANDROID_HOME/platform-tools/adb`). Only required for Android devices and emulators.",
  emulator:
    "Android Emulator not found. Install via Android Studio → SDK Manager → Emulator, or `sdkmanager 'emulator'`. If installed, ensure `emulator` is on PATH or set `$ANDROID_HOME` to the SDK root (the resolver checks `$ANDROID_HOME/emulator/emulator`). Only required to launch new Android emulators via `boot-device`.",
};

async function probe(dep: ToolDependency): Promise<boolean> {
  // Android binaries support an `$ANDROID_HOME` fallback in addition to PATH
  // (Android Studio sets ANDROID_HOME but does NOT add `$ANDROID_HOME/emulator`
  // to PATH on macOS — the most common state for users coming from Studio).
  // Funnel the lookup through `resolveAndroidBinary` so the dep check sees an
  // SDK install even when the binary is off PATH; otherwise a host with a
  // working SDK would 424 with an "install adb"-style hint that doesn't
  // describe the actual problem.
  if (dep === "adb" || dep === "emulator") {
    return (await resolveAndroidBinary(dep)) !== null;
  }
  try {
    // Probe for the binary without invoking it. We avoid a bare `${dep}` call
    // because `xcrun` (and similar) can fork actual tool work / prompt the
    // license agreement dialog on first use; `command -v` / `where` only do
    // a PATH lookup. Windows uses `where`; POSIX uses `command -v` via
    // `/bin/sh` (portable across bash/zsh/dash/etc).
    if (process.platform === "win32") {
      await execFileAsync("where", [dep], { timeout: 2_000 });
    } else {
      await execFileAsync("/bin/sh", ["-c", `command -v ${dep}`], { timeout: 2_000 });
    }
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
 * Single-dep convenience over `ensureDeps`. `dispatchByPlatform` already
 * preflights the matched branch's `requires`; this is for tools that pick
 * a platform path internally (e.g. `boot-device`, where there is no udid to
 * classify yet) and want the same 424-with-install-hint failure mode.
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
