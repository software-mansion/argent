import { FAILURE_CODES, withFailureSignal, type ToolDependency } from "@argent/registry";
import { resolveAndroidBinary } from "./android-binary";
import { resolveVegaBinary } from "./vega-cli";
import { commandOnPath } from "./command-on-path";

/**
 * Thrown when a declared host-binary dependency (e.g. `adb`, `xcrun`) can't be
 * resolved. The HTTP dispatcher maps it to 424; `.message` is the install hint,
 * safe to bubble straight to the agent.
 */
export class DependencyMissingError extends Error {
  readonly missing: ToolDependency[];
  constructor(missing: ToolDependency[], message: string) {
    super(message);
    this.name = "DependencyMissingError";
    this.missing = missing;
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
      failure_stage: "tool_dependency_preflight",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    });
  }
}

// Short TTL: a burst of tool calls pays for at most one probe per dep, yet an
// install mid-session recovers without a tool-server restart.
const CACHE_TTL_MS = 60_000;
type CacheEntry = { available: boolean; checkedAt: number };
const cache = new Map<ToolDependency, CacheEntry>();

// This text is what the LLM sees on a missing-dep failure, so each hint says
// how to unblock the user.
const INSTALL_HINTS: Record<ToolDependency, string> = {
  "xcrun":
    "Xcode command-line tools are not installed. Run `xcode-select --install` (or install Xcode from the App Store) and retry. Only required for iOS simulators.",
  "adb":
    "Android SDK Platform Tools not found. Install with `brew install --cask android-platform-tools` or via Android Studio → SDK Manager. If installed, ensure `adb` is on PATH or set `$ANDROID_HOME` to the SDK root (the resolver checks `$ANDROID_HOME/platform-tools/adb`). Only required for Android devices and emulators.",
  "emulator":
    "Android Emulator not found. Install via Android Studio → SDK Manager → Emulator, or `sdkmanager 'emulator'`. If installed, ensure `emulator` is on PATH or set `$ANDROID_HOME` to the SDK root (the resolver checks `$ANDROID_HOME/emulator/emulator`). Only required to launch new Android emulators via `boot-device`.",
  "sim-remote":
    "`sim-remote` CLI not found on PATH. Install via the radon-cloud project (see its README) and run `sim-remote login` before invoking any ios-remote tool. Only required for remote iOS simulators.",
  "vega":
    "Vega SDK CLI not found. Install the Amazon Vega SDK and run `source ~/vega/env` so `vega` (or its `kepler` alias) is on PATH; the resolver also checks `~/vega/bin/vega`. Only required for Vega (Fire TV) devices.",
};

async function probe(dep: ToolDependency): Promise<boolean> {
  // Android Studio sets ANDROID_HOME but leaves the SDK subdirs off PATH, so
  // resolve through the SDK-aware resolver — a PATH-only check would 424 on a
  // host whose SDK works fine.
  if (dep === "adb" || dep === "emulator") {
    return (await resolveAndroidBinary(dep)) !== null;
  }
  // `vega`/`kepler` is only on PATH after `source ~/vega/env`, so also let the
  // resolver check the SDK's default install location.
  if (dep === "vega") {
    return (await resolveVegaBinary()) !== null;
  }
  // Probe existence without invoking the dep: a bare `xcrun` can pop the Xcode
  // license dialog on first use.
  return (await commandOnPath(dep)) !== null;
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
 * Probes all deps in parallel.
 *
 * @throws DependencyMissingError listing every missing dep, so the agent isn't
 * sent back for the same tool twice.
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
 * preflights the matched branch's `requires`; this is for tools that pick a
 * platform path internally (e.g. `boot-device`, which has no udid to classify
 * yet).
 */
export async function ensureDep(dep: ToolDependency): Promise<void> {
  return ensureDeps([dep]);
}

/** Test-only: clear the availability cache between tests. */
export function __resetDepCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only: mark deps available so the preflight doesn't reach the probe and
 * show up in tests' `execFile` mocks.
 */
export function __primeDepCacheForTests(deps: ToolDependency[]): void {
  const now = Date.now();
  for (const d of deps) cache.set(d, { available: true, checkedAt: now });
}
