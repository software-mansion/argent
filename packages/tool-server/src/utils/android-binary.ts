import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandOnPath } from "./command-on-path";

export type AndroidBinaryName = "adb" | "emulator";

// Subdirectory under the SDK root where each binary ships.
const SUBDIR: Record<AndroidBinaryName, string> = {
  adb: "platform-tools",
  emulator: "emulator",
};

// The SDK-root fallbacks below build a literal path and `access()` it, so on
// Windows they need the `.exe` the SDK ships; PATH lookups resolve it already.
const BIN_EXT = process.platform === "win32" ? ".exe" : "";

function binFileName(name: AndroidBinaryName): string {
  return `${name}${BIN_EXT}`;
}

interface CacheEntry {
  path: string | null;
  checkedAt: number;
}

// Short TTL so a user who installs the missing SDK package mid-session
// recovers without restarting the tool-server.
const CACHE_TTL_MS = 60_000;
const cache = new Map<AndroidBinaryName, CacheEntry>();

/**
 * Resolve an Android SDK binary to an absolute path, or `null`.
 *
 * Order: PATH, `$ANDROID_HOME/<subdir>`, `$ANDROID_SDK_ROOT/<subdir>`, then the
 * OS defaults in `defaultAndroidRoots()`. The defaults matter because a server
 * spawned by a GUI process inherits neither PATH nor the env vars exported from
 * shell rc files; PATH-only lookup then made a working Android Studio install
 * (which sets ANDROID_HOME but not PATH) look like an empty `listAvds()`.
 *
 * Callers that surface the failure to users should funnel through `ensureDep`
 * so the message names the install hint.
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
  // PATH first, so an explicit override there wins over the SDK roots.
  const onPath = await commandOnPath(name);
  if (onPath) return onPath;
  for (const root of androidRoots()) {
    const candidate = join(root, SUBDIR[name], binFileName(name));
    try {
      // X_OK rather than F_OK: a non-executable file at the canonical path is a
      // partial install, and falling through beats an EACCES at spawn time.
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function androidRoots(): string[] {
  // ANDROID_HOME (canonical) before ANDROID_SDK_ROOT (its legacy alias), so an
  // explicitly set ANDROID_HOME wins over a stale value inherited from elsewhere.
  const envRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (v): v is string => Boolean(v && v.trim())
  );
  return [...envRoots, ...defaultAndroidRoots()];
}

/** Canonical SDK install locations probed after the env vars come up empty. */
function defaultAndroidRoots(): string[] {
  const home = homedir();
  const roots = [
    join(home, "Library", "Android", "sdk"), // macOS Android Studio default
    join(home, "Android", "Sdk"), // Linux Android Studio default
    join(home, "android-sdk"), // manual-install convention; no installer picks it
    "/opt/android-sdk",
    "/usr/lib/android-sdk", // Debian/Ubuntu `android-sdk` apt package
    "/usr/local/share/android-sdk", // Homebrew cask
  ];
  // Windows Studio default is %LOCALAPPDATA%\Android\Sdk; also probe the
  // canonical AppData\Local layout in case LOCALAPPDATA wasn't inherited.
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) roots.push(join(localAppData, "Android", "Sdk"));
    roots.push(join(home, "AppData", "Local", "Android", "Sdk"));
  }
  return roots;
}

/** Test-only: clear the resolver cache between tests. */
export function __resetAndroidBinaryCacheForTesting(): void {
  cache.clear();
}
