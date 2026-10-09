import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants as fsConstants } from "node:fs/promises";
import { join } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";

const execFileAsync = promisify(execFile);

/**
 * Wrapper for DevEco Studio's `Emulator` manager — HarmonyOS' `emulator` and
 * `avdmanager` rolled into one (`-list` / `-create` / `-start` / `-stop` /
 * `-imageList` / `-install`).
 *
 * It violates the convention every other subprocess wrapper here relies on: the
 * exit code does not indicate success. Measured against DevEco Studio 6.1
 * (Emulator 6.1.1.200):
 *
 *   -list      (none)           exit 0   ok
 *   -create    (no image)       exit 0   FAILED
 *   -stop      (missing)        exit 0   FAILED
 *   -install   (outside China)  exit 0   FAILED
 *   -start     (missing)        exit 1   FAILED
 *
 * So a failure is usually exit 0, but not always — `-start` is the outlier. Since
 * the code is unreliable in both directions, `runHarmonyEmulator` deliberately
 * does NOT reject on a non-zero exit: it returns the child's output either way
 * and leaves the verdict to `emulatorFailure`, which reads what was printed on
 * either stream. That keeps one classification path instead of two that
 * disagree.
 *
 * `hdc`, the HarmonyOS device connector, lives in `harmony-hdc.ts`: this
 * manager knows about instances, `hdc` knows about targets, and the two are
 * separate binaries with separate failure vocabularies.
 */

/** The manager prints this exact token for an empty list rather than no output. */
export const HARMONY_EMPTY_SENTINEL = "[Empty]";

/**
 * DevEco Studio's default macOS install location. Non-macOS hosts (DevEco also
 * ships for Windows) are reached through `$DEVECO_STUDIO_HOME` rather than a
 * second hardcoded root, because only the macOS layout has been verified here.
 */
const MACOS_DEVECO_APP = "/Applications/DevEco-Studio.app";

/** Path of the emulator manager relative to a DevEco Studio install root. */
const EMULATOR_RELATIVE = join("tools", "emulator", "Emulator");

/**
 * DevEco Studio install roots to search, in order.
 *
 * `$DEVECO_STUDIO_HOME` is tried ahead of the macOS default rather than in place
 * of it — the same ordering `androidRoots()` gives `$ANDROID_HOME`, for the same
 * reason: a stale or mis-set variable must not be able to hide a working
 * install. Here that failure is silent, since both readers turn a null binary
 * into an empty device list.
 *
 * Every root is searched with `Contents` appended too, because on macOS the
 * install root a user can name is the `DevEco-Studio.app` bundle while the SDK
 * and tools sit one level inside it. Both spellings name the same install.
 */
function devecoRoots(): string[] {
  const roots: string[] = [];
  const configured = process.env.DEVECO_STUDIO_HOME?.trim();
  if (configured) roots.push(configured);
  if (process.platform === "darwin") roots.push(MACOS_DEVECO_APP);
  return roots.flatMap((root) => [root, join(root, "Contents")]);
}

// X_OK rather than F_OK (as in vega-cli.ts): a present-but-non-executable file
// at a DevEco path is a partial install, so the search moves on to the next root
// rather than returning a path that would surface as an opaque EACCES at spawn
// instead of the actionable not-found hint.
async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to a binary that ships inside DevEco Studio, named by its path
 * relative to the install root, or null when no candidate root holds an
 * executable copy of it. Shared with `harmony-hdc.ts`: `hdc` and the emulator
 * manager come out of one install, so they have to agree on where it is.
 */
export async function resolveDevecoBinary(relative: string): Promise<string | null> {
  for (const root of devecoRoots()) {
    const candidate = join(root, relative) + BIN_EXT;
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

// A Windows DevEco install ships `hdc.exe` and `Emulator.exe`. These candidates
// are literal paths handed to `access()`, not PATH lookups, so nothing resolves
// the extension for them the way `where` does for `commandOnPath` — without it
// every root misses and `$DEVECO_STUDIO_HOME`, the only way to point at a
// non-macOS install, can never resolve. Same reasoning and same shape as
// `android-binary.ts`' `BIN_EXT`. Empty on POSIX, where the binaries are
// extensionless.
const BIN_EXT = process.platform === "win32" ? ".exe" : "";

// Mirrors android-binary.ts / vega-cli.ts: memoize briefly so a burst of tool
// calls pays one lookup, but a *negative* result expires — a user who installs
// DevEco Studio mid-session recovers without restarting the tool-server.
const BINARY_TTL_MS = 60_000;
let cachedEmulator: { path: string | null; checkedAt: number } | undefined;

/**
 * Absolute path to the HarmonyOS emulator manager, or null when DevEco Studio
 * isn't installed. Not resolved from PATH: the binary is named `Emulator`, too
 * generic a name to match on PATH without risking an unrelated executable.
 */
export async function resolveHarmonyEmulator(): Promise<string | null> {
  const now = Date.now();
  if (cachedEmulator && now - cachedEmulator.checkedAt < BINARY_TTL_MS) {
    return cachedEmulator.path;
  }
  const path = await resolveDevecoBinary(EMULATOR_RELATIVE);
  cachedEmulator = { path, checkedAt: now };
  return path;
}

export interface HarmonyRunResult {
  stdout: string;
  stderr: string;
}

/**
 * Per-`Emulator` ceiling. Exported for the same reason `UITEST_TIMEOUT_MS` is: a
 * caller on a deadline of its own has to cap against it, since a manager call
 * left on this ceiling can outlast the budget the whole boot was given.
 */
export const EMULATOR_TIMEOUT_MS = 30_000;

/** See `HDC_KILL_SIGNAL`: a SIGTERM the child may ignore leaves `timeout` unenforced. */
const EMULATOR_KILL_SIGNAL = "SIGKILL" as const;

/** Said by every caller that needs the manager, so they cannot drift apart. */
export const EMULATOR_NOT_FOUND =
  "The HarmonyOS `Emulator` manager was not found. Install DevEco Studio: a macOS install " +
  "at /Applications/DevEco-Studio.app is found on its own, and anywhere else set " +
  "`$DEVECO_STUDIO_HOME` to the directory holding `tools/emulator/Emulator` (on macOS " +
  "that is the `DevEco-Studio.app` bundle, or the `Contents` directory inside it). " +
  "Then retry.";

export async function runHarmonyEmulator(
  args: string[],
  timeoutMs = EMULATOR_TIMEOUT_MS
): Promise<HarmonyRunResult> {
  const bin = await resolveHarmonyEmulator();
  if (!bin) {
    throw new FailureError(EMULATOR_NOT_FOUND, {
      error_code: FAILURE_CODES.HARMONY_EMULATOR_NOT_FOUND,
      failure_stage: "harmony_emulator_resolve_binary",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
      failure_command: "deveco_emulator",
    });
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      killSignal: EMULATOR_KILL_SIGNAL,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as {
      killed?: boolean;
      signal?: string | null;
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    // The child ran and exited non-zero (`-start` on a missing instance does
    // this) — its diagnostic is on stdout, so hand the output back and let the
    // caller classify it exactly as it would an exit-0 failure. A numeric `code`
    // is what distinguishes this from a spawn error, whose `code` is a string
    // like ENOENT.
    if (!e.killed && typeof e.code === "number" && (e.stdout != null || e.stderr != null)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    // Spawn failure or timeout SIGKILL: no diagnostic to classify, so surface it
    // the way every other subprocess wrapper here does — including the kind, so
    // a manager killed at its ceiling is not counted as one that failed.
    throw new FailureError(
      formatSubprocessFailure("Emulator", args, err),
      {
        error_code: FAILURE_CODES.HARMONY_EMULATOR_COMMAND_FAILED,
        failure_stage: "harmony_emulator_run",
        failure_area: "tool_server",
        error_kind: e.killed || e.signal ? "timeout" : "subprocess",
        ...subprocessFailureMetadata(err, "deveco_emulator"),
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
}

/**
 * Emulator-image downloads are restricted by Huawei to mainland China; outside it
 * `Emulator -install` prints exactly this and exits 0. Without an image no
 * instance can be created, so this is the wall a host outside it hits until one
 * is obtained — worth naming precisely instead of reporting the generic create
 * failure it causes.
 */
const CHINA_ONLY_MARKER = "available only in the Chinese mainland";

/**
 * Verified `Emulator` failure diagnostics, each observed on a real invocation.
 *
 * Ordered most-specific first, because a failure often prints two lines and the
 * first match wins. `-start` on a missing instance prints both `"<name>" is not
 * found. Please create the device(folder): <path>` and a bare `Unable to start
 * the emulator`; the naming line is the one that tells the caller what to do, so
 * the generic trailers sit at the bottom.
 */
const EMULATOR_FAILURE_MARKERS = [
  CHINA_ONLY_MARKER,
  "Cannot find image",
  "is not found. Please create the device",
  "failed, emulator is not exists",
  "this emulator instance is already running",
  "Device create fail",
  "Unable to start the emulator",
] as const;

/**
 * The diagnostic the emulator manager printed, or null if the call succeeded.
 * Matched against the verified marker list rather than a bare "fail" substring,
 * so an instance or image name containing "fail" cannot forge a failure.
 */
export function emulatorFailure(result: HarmonyRunResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const marker = EMULATOR_FAILURE_MARKERS.find((m) => text.includes(m));
  if (!marker) return null;
  const line = text.split(/\r?\n/).find((l) => l.includes(marker));
  return (line ?? marker).trim();
}

/** True when the diagnostic is Huawei's mainland-China image-download restriction. */
export function isChinaOnlyRestriction(diagnostic: string): boolean {
  return diagnostic.includes(CHINA_ONLY_MARKER);
}
