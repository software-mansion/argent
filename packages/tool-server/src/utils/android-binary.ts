import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AndroidBinaryName = "adb" | "emulator";

// Subdirectory under $ANDROID_HOME where each binary ships. `adb` lives in
// `platform-tools/` (separate SDK package); `emulator` lives in `emulator/`.
// Both are the canonical install layouts every Android tool (Studio,
// avdmanager, react-native CLI) assumes — mirroring them is what makes
// argent's resolution behave the same way the rest of the toolchain does.
const SUBDIR: Record<AndroidBinaryName, string> = {
  adb: "platform-tools",
  emulator: "emulator",
};

interface CacheEntry {
  path: string | null;
  checkedAt: number;
}

// Short TTL for the negative case so a user who installs the missing package
// mid-session recovers without restarting the tool-server. Positive results
// effectively never expire in practice — SDK location doesn't move during a
// session — but the same TTL keeps the eviction logic uniform.
const CACHE_TTL_MS = 60_000;
const cache = new Map<AndroidBinaryName, CacheEntry>();

/**
 * Resolve an Android SDK binary to an absolute path.
 *
 * Lookup order — matches what Android Studio, react-native CLI, and the
 * `avdmanager`/`sdkmanager` wrappers do, in this priority:
 *   1. `command -v <name>` (PATH)
 *   2. `$ANDROID_HOME/<subdir>/<name>` if executable
 *   3. `$ANDROID_SDK_ROOT/<subdir>/<name>` if executable
 *   4. OS-default install locations (Android Studio defaults + common manual
 *      paths) — see `androidRoots()`. Lets the resolver succeed when neither
 *      env var nor PATH was inherited from the user's shell, which is the
 *      typical state for an MCP server spawned by a GUI process.
 *
 * Returns `null` if none of those resolve. Callers that surface the failure
 * to users should funnel through `ensureDep` so the missing-binary message
 * names the install hint instead of producing a downstream "no AVDs"-style
 * symptom.
 *
 * Argent previously called `execFile("emulator", ...)` and `execFile("adb",
 * ...)` directly, which only honors PATH. Users with a working SDK install
 * but `$ANDROID_HOME/emulator` not on PATH (the default state on macOS after
 * an Android Studio install — Studio sets ANDROID_HOME but leaves PATH
 * alone) saw `listAvds()` silently return `[]`, which `boot-device` then
 * mis-reported as "no AVDs". This resolver closes that gap.
 */
export async function resolveAndroidBinary(name: AndroidBinaryName): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.path;
  const resolved = await probe(name);
  cache.set(name, { path: resolved, checkedAt: now });
  return resolved;
}

async function probe(name: AndroidBinaryName): Promise<string | null> {
  // PATH first — preserves prior behavior for users who already have the
  // binary on PATH (e.g. Homebrew adb at /opt/homebrew/bin/adb), and means
  // a sysadmin override on PATH still wins over $ANDROID_HOME.
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
      timeout: 2_000,
    });
    const trimmed = stdout.trim();
    // `command -v` prints nothing on miss but returns non-zero, so we only
    // get here on success — but defend against an empty stdout anyway in
    // case a future shell quirk decouples the two.
    if (trimmed) return trimmed;
  } catch {
    // fall through to SDK-root fallbacks
  }
  for (const root of androidRoots()) {
    const candidate = join(root, SUBDIR[name], name);
    try {
      // X_OK rather than F_OK: a non-executable file at the canonical path
      // means a corrupted/partial install, and falling back to the next root
      // (or returning null) is the right move — spawning a non-executable
      // path would only produce an EACCES at run-time.
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try the next root
    }
  }
  return null;
}

function androidRoots(): string[] {
  // ANDROID_HOME is the canonical env var; ANDROID_SDK_ROOT is the legacy
  // alias Android still honors. Some environments set only one. We try both
  // in declared order so a user who set ANDROID_HOME explicitly always wins
  // over a stale ANDROID_SDK_ROOT inherited from elsewhere.
  const envRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (v): v is string => Boolean(v && v.trim())
  );
  // OS-default install locations. Important: an MCP server (or any process
  // spawned by a GUI app like Claude Code's desktop client) inherits the GUI's
  // env, which on Linux+Wayland and macOS Finder-launched apps lacks the
  // shell-rc-exported ANDROID_HOME. Probing the canonical install paths lets
  // a user who installed via Android Studio (or apt) have argent "just work"
  // without hand-editing .mcp.json or exporting env vars in shell rc files
  // they don't realize the GUI doesn't read.
  return [...envRoots, ...defaultAndroidRoots()];
}

/**
 * Canonical SDK install locations argent probes after env vars come up empty.
 *
 * Picked to match what Android Studio installs by default and what the
 * upstream Android docs / common Linux package managers ship. Order matters
 * only when the *same* SDK is reachable through two of these — first match
 * wins via `androidRoots()`'s linear scan.
 */
function defaultAndroidRoots(): string[] {
  const home = homedir();
  const roots = [
    // Android Studio defaults (the two big ones — covers the majority of
    // user installs that arrive without any env-var setup).
    join(home, "Library", "Android", "sdk"), // macOS Android Studio default
    join(home, "Android", "Sdk"), // Linux Android Studio default
    // Common manual install convention. Not picked by any installer but used
    // often enough in tutorials and Dockerfiles that probing it costs little.
    join(home, "android-sdk"),
    // System-wide locations (Linux package managers, Homebrew on macOS).
    "/opt/android-sdk",
    "/usr/lib/android-sdk", // Debian/Ubuntu `android-sdk` apt package
    "/usr/local/share/android-sdk", // Homebrew cask
  ];
  return roots;
}

/** Test-only: clear the resolver cache between tests. */
export function __resetAndroidBinaryCacheForTesting(): void {
  cache.clear();
}
