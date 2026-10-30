import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants as fsConstants } from "node:fs/promises";
import { join } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";

const execFileAsync = promisify(execFile);

/**
 * Wrapper for DevEco Studio's `Emulator` manager, whose exit code is unreliable
 * both ways:
 *
 *   -create    (no image)       exit 0   FAILED
 *   -stop      (missing)        exit 0   FAILED
 *   -start     (missing)        exit 1   FAILED
 *
 * So `runHarmonyEmulator` returns output on any exit and `emulatorFailure`
 * classifies it.
 */

export const HARMONY_EMPTY_SENTINEL = "[Empty]";

/** Only the macOS layout is verified; other hosts set `$DEVECO_STUDIO_HOME`. */
const MACOS_DEVECO_APP = "/Applications/DevEco-Studio.app";

const EMULATOR_RELATIVE = join("tools", "emulator", "Emulator");

/**
 * `$DEVECO_STUDIO_HOME` first, then the macOS default, so a stale variable
 * cannot hide a working install (as `androidRoots()`). Each root is also tried
 * with `Contents`, since a user may name the `.app` bundle.
 */
function devecoRoots(): string[] {
  const roots: string[] = [];
  const configured = process.env.DEVECO_STUDIO_HOME?.trim();
  if (configured) roots.push(configured);
  if (process.platform === "darwin") roots.push(MACOS_DEVECO_APP);
  return roots.flatMap((root) => [root, join(root, "Contents")]);
}

// X_OK: a non-executable file is a partial install; move on rather than EACCES at spawn.
async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A binary inside DevEco Studio by install-relative path; shared with `harmony-hdc.ts`. */
export async function resolveDevecoBinary(relative: string): Promise<string | null> {
  for (const root of devecoRoots()) {
    const candidate = join(root, relative) + BIN_EXT;
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

// Literal paths given to `access()` get no PATHEXT resolution; see `android-binary.ts`.
const BIN_EXT = process.platform === "win32" ? ".exe" : "";

// Negative results expire, so installing DevEco mid-session needs no restart.
const BINARY_TTL_MS = 60_000;
let cachedEmulator: { path: string | null; checkedAt: number } | undefined;

/** Not resolved from PATH: `Emulator` is too generic a name. */
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

/** Exported so a caller on its own deadline can cap below it. */
export const EMULATOR_TIMEOUT_MS = 30_000;

const EMULATOR_KILL_SIGNAL = "SIGKILL" as const;

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
    // Non-zero exit with output (`-start` on a missing instance): classify as
    // any other result. A spawn error's `code` is a string.
    if (!e.killed && typeof e.code === "number" && (e.stdout != null || e.stderr != null)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
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

/** Printed by `Emulator -install` outside mainland China, with exit 0. */
const CHINA_ONLY_MARKER = "available only in the Chinese mainland";

/** Verified diagnostics, most specific first: a failure often prints a generic trailer too. */
const EMULATOR_FAILURE_MARKERS = [
  CHINA_ONLY_MARKER,
  "Cannot find image",
  "is not found. Please create the device",
  "failed, emulator is not exists",
  "this emulator instance is already running",
  "Device create fail",
  "Unable to start the emulator",
] as const;

/** The printed diagnostic, or null. Verified markers only, so a name containing "fail" cannot forge one. */
export function emulatorFailure(result: HarmonyRunResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const marker = EMULATOR_FAILURE_MARKERS.find((m) => text.includes(m));
  if (!marker) return null;
  const line = text.split(/\r?\n/).find((l) => l.includes(marker));
  return (line ?? marker).trim();
}

export function isChinaOnlyRestriction(diagnostic: string): boolean {
  return diagnostic.includes(CHINA_ONLY_MARKER);
}
