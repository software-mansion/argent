import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";
import { commandOnPath } from "./command-on-path";
import { resolveDevecoBinary } from "./harmony-cli";

const execFileAsync = promisify(execFile);

/**
 * Wrapper for `hdc`, the HarmonyOS `adb`, which exits 0 for everything:
 *
 *   shell (unknown target)       exit 0   `[Fail]Not match target...`
 *   file recv (missing file)     exit 0   `[Fail]Error opening file...`
 *   shell 'exit 3'               exit 0   remote status discarded
 *
 * So failures are classified from output, and `runHdcShell` echoes `$?` back.
 */

const HDC_FAILURE_PREFIX = "[Fail]";

export const HDC_EMPTY_SENTINEL = "[Empty]";

const RC_SENTINEL = "__argent_hdc_rc";

const HDC_RELATIVE = join("sdk", "default", "openharmony", "toolchains", "hdc");

const BINARY_TTL_MS = 60_000;
let cachedHdc: { path: string | null; checkedAt: number } | undefined;

/**
 * `hdc` from DevEco Studio, else PATH: unlike `Emulator`, the name is
 * distinctive enough to trust there.
 */
export async function resolveHdc(): Promise<string | null> {
  const now = Date.now();
  if (cachedHdc && now - cachedHdc.checkedAt < BINARY_TTL_MS) {
    return cachedHdc.path;
  }
  const path = (await resolveDevecoBinary(HDC_RELATIVE)) ?? (await commandOnPath("hdc"));
  cachedHdc = { path, checkedAt: now };
  return path;
}

async function resolveHdcOrThrow(): Promise<string> {
  const path = await resolveHdc();
  if (!path) {
    throw new FailureError(
      "`hdc` (the HarmonyOS device connector) was not found. Install DevEco Studio: a macOS " +
        "install at /Applications/DevEco-Studio.app is found on its own, and anywhere else set " +
        "`$DEVECO_STUDIO_HOME` to the directory holding " +
        "`sdk/default/openharmony/toolchains/hdc` (on macOS that is the `DevEco-Studio.app` " +
        "bundle, or the `Contents` directory inside it). Alternatively put `hdc` from the " +
        "OpenHarmony command-line tools on PATH.",
      {
        error_code: FAILURE_CODES.HARMONY_HDC_NOT_FOUND,
        failure_stage: "harmony_hdc_resolve_binary",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "hdc",
      }
    );
  }
  return path;
}

interface HdcRunResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// `execFile` sends `killSignal` once, and an `hdc` client blocked on a wedged
// daemon ignores SIGTERM. Only the direct child: a group kill would take the
// shared daemon. See `ADB_KILL_SIGNAL`.
const HDC_KILL_SIGNAL = "SIGKILL" as const;

/** Resolves with output whatever the exit code; rejects only on spawn failure or timeout. */
export async function runHdc(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HdcRunResult> {
  const bin = await resolveHdcOrThrow();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      killSignal: HDC_KILL_SIGNAL,
      maxBuffer: 64 * 1024 * 1024,
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
    if (!e.killed && typeof e.code === "number" && (e.stdout != null || e.stderr != null)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw new FailureError(formatSubprocessFailure("hdc", args, err), {
      error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
      failure_stage: "harmony_hdc_run",
      failure_area: "tool_server",
      error_kind: e.killed || e.signal ? "timeout" : "subprocess",
      ...subprocessFailureMetadata(err, "hdc"),
    });
  }
}

/**
 * The column-0 `[Fail]` line, or null. Anchored so a remote command's own
 * output, which `runHdcShell` passes through here, cannot forge one.
 */
export function hdcFailure(result: HdcRunResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const line = text.split(/\r?\n/).find((l) => l.startsWith(HDC_FAILURE_PREFIX));
  return line ? line.trim() : null;
}

/**
 * Unprefixed prose `hdc` printed, or null: a client that cannot reach its
 * server writes `Connect server failed` to stderr and exits 0. A line with a
 * space and no tab is neither a table row nor a connect key.
 */
export function hdcProse(result: HdcRunResult): string | null {
  return (
    `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("[") && /\s/.test(l) && !l.includes("\t")) ?? null
  );
}

/** POSIX single-quoting for the remote `/bin/sh` line `hdc shell` runs. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface HdcShellResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run `command` (quote caller values with `shellQuote`) and return its output
 * and real exit status. Throws on a transport failure.
 */
export async function runHdcShell(
  connectKey: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HdcShellResult> {
  const result = await runHdc(
    ["-t", connectKey, "shell", `${command}; echo ${RC_SENTINEL}=$?`],
    timeoutMs
  );
  const failure = hdcFailure(result);
  if (failure) {
    throw new FailureError(
      `hdc could not reach HarmonyOS device '${connectKey}': ${failure}. ` +
        `Check that it is still listed by \`hdc list targets\` and that USB debugging is authorised.`,
      {
        error_code: FAILURE_CODES.HARMONY_DEVICE_UNREACHABLE,
        failure_stage: "harmony_hdc_shell",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "hdc",
      }
    );
  }
  const lines = `${result.stdout}`.split(/\r?\n/);
  // Last match: the command's own output may resemble the sentinel.
  const idx = lines.findLastIndex((l) => l.trim().startsWith(`${RC_SENTINEL}=`));
  if (idx === -1) {
    // No status. Empty stdout means `hdc` never reached the device (report its
    // prose); any output means the command was cut off.
    const prose = result.stdout.trim().length === 0 ? hdcProse(result) : null;
    throw new FailureError(
      prose
        ? `hdc could not run \`${command}\` on HarmonyOS device '${connectKey}': ${prose}`
        : `HarmonyOS device '${connectKey}' returned no exit status for \`${command}\`. ` +
            `The command was terminated on the device or the hdc connection dropped mid-call.`,
      {
        error_code: FAILURE_CODES.HARMONY_SHELL_NO_STATUS,
        failure_stage: "harmony_hdc_shell",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      }
    );
  }
  const exitCode = Number.parseInt(lines[idx].trim().slice(RC_SENTINEL.length + 1), 10);
  return {
    stdout: lines.slice(0, idx).join("\n").replaceAll("\r", "").trimEnd(),
    exitCode: Number.isFinite(exitCode) ? exitCode : -1,
  };
}

/** Matched positively: an unreachable server prints no `[Fail]` and exits 0. */
const HDC_TRANSFER_OK = "FileTransfer finish";

export async function hdcFileRecv(
  connectKey: string,
  remotePath: string,
  localPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const result = await runHdc(["-t", connectKey, "file", "recv", remotePath, localPath], timeoutMs);
  const failure = result.stdout.includes(HDC_TRANSFER_OK)
    ? null
    : (hdcFailure(result) ??
      hdcProse(result) ??
      "hdc reported neither a transfer nor a diagnostic");
  if (failure) {
    throw new FailureError(
      `Failed to copy '${remotePath}' off HarmonyOS device '${connectKey}': ${failure}`,
      {
        error_code: FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED,
        failure_stage: "harmony_hdc_file_recv",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      }
    );
  }
}
