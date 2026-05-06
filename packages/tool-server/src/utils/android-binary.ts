import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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
    let stdout: string;
    if (process.platform === "win32") {
      // `where adb` resolves to `adb.exe` automatically. May print multiple
      // lines (one per match) — take the first.
      ({ stdout } = await execFileAsync("where", [name], { timeout: 2_000 }));
    } else {
      ({ stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
        timeout: 2_000,
      }));
    }
    // `command -v` / `where` print nothing on miss but return non-zero, so we
    // only get here on success. Pick the first non-empty line — `where` can
    // emit a leading blank line in some shells, and command-v sometimes
    // appends a trailing newline; both are tolerated by `.find(Boolean)`.
    const trimmed = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (trimmed) return trimmed;
  } catch {
    // fall through to SDK-root fallbacks
  }
  for (const root of androidRoots()) {
    const candidate = join(root, SUBDIR[name], binaryFilename(name));
    try {
      // X_OK rather than F_OK: a non-executable file at the canonical path
      // means a corrupted/partial install, and falling back to the next root
      // (or returning null) is the right move — spawning a non-executable
      // path would only produce an EACCES at run-time. Note that on Windows
      // X_OK degrades to F_OK in Node — Win32 has no exec bit — so a
      // non-executable .exe still passes here, which is fine since spawn()
      // surfaces the EACCES at run time anyway.
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try the next root
    }
  }
  return null;
}

function binaryFilename(name: AndroidBinaryName): string {
  // Windows ships these as `adb.exe` / `emulator.exe`; on macOS and Linux
  // they use the bare name. Note that PATH lookups via `where` already
  // surface the `.exe`, so this only matters for the SDK-root fallback.
  return process.platform === "win32" ? `${name}.exe` : name;
}

function androidRoots(): string[] {
  // ANDROID_HOME is the canonical env var; ANDROID_SDK_ROOT is the legacy
  // alias Android still honors. Some environments set only one. We try both
  // in declared order so a user who set ANDROID_HOME explicitly always wins
  // over a stale ANDROID_SDK_ROOT inherited from elsewhere.
  return [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter((v): v is string =>
    Boolean(v && v.trim())
  );
}

/** Test-only: clear the resolver cache between tests. */
export function __resetAndroidBinaryCacheForTesting(): void {
  cache.clear();
}
