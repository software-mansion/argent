import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";
import { commandOnPath } from "./command-on-path";
import { resolveDevecoBinary } from "./harmony-cli";

const execFileAsync = promisify(execFile);

/**
 * Wrapper for `hdc`, the HarmonyOS device connector — the platform's `adb`.
 *
 * It shares the `Emulator` manager's defining hazard (see `harmony-cli.ts`) and
 * makes it worse: `hdc` exits 0 for *everything*. Measured against hdc 3.2.0d:
 *
 *   list targets           (none)             exit 0   ok, prints `[Empty]`
 *   shell echo hi                             exit 0   ok
 *   shell (unknown target)                    exit 0   FAILED, `[Fail]Not match target...`
 *   file recv (missing file)                  exit 0   FAILED, `[Fail]Error opening file...`
 *   shell 'exit 3'                            exit 0   remote status DISCARDED
 *
 * Two consequences drive this module:
 *
 * 1. Transport failures are classified from what was printed, never the exit
 *    code, so `runHdc` returns output rather than rejecting on a non-zero exit.
 *    Device-level errors carry a `[Fail]` prefix; a client that cannot reach its
 *    own server does not, so both `hdcFailure` and `hdcProse` are needed to
 *    cover the two, and a command with a positive success line is read off that
 *    instead of off the absence of either.
 * 2. The remote command's own exit status never reaches the host — `hdc shell`
 *    reports the status of the *connection*, not of what ran. `runHdcShell`
 *    therefore appends an `echo` of `$?` and parses it back off stdout, which is
 *    the only way to tell `uitest` succeeding from `uitest` not being installed.
 */

/** Prefix `hdc` puts on its own transport-level diagnostics. */
const HDC_FAILURE_PREFIX = "[Fail]";

/** `hdc list targets` prints this token rather than nothing when no device is attached. */
export const HDC_EMPTY_SENTINEL = "[Empty]";

/**
 * Sentinel used to smuggle the remote exit status back over a transport that
 * drops it. Prefixed with `__argent` so it cannot collide with a line the
 * command under test legitimately prints.
 */
const RC_SENTINEL = "__argent_hdc_rc";

/** Path of `hdc` relative to a DevEco Studio install root. */
const HDC_RELATIVE = join("sdk", "default", "openharmony", "toolchains", "hdc");

const BINARY_TTL_MS = 60_000;
let cachedHdc: { path: string | null; checkedAt: number } | undefined;

/**
 * Absolute path to `hdc`, or null when neither DevEco Studio nor a standalone
 * OpenHarmony command-line-tools install provides it.
 *
 * Unlike the emulator manager — whose binary is named `Emulator`, too generic to
 * match on PATH — `hdc` is a distinctive name owned by the HarmonyOS toolchain,
 * so PATH is consulted as a fallback for hosts that installed the command-line
 * tools without the IDE.
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

// `execFile`'s `timeout` sends `killSignal` once and never escalates, and the
// default SIGTERM is exactly what an `hdc` client blocked on a wedged daemon can
// ignore — leaving the parent waiting past the deadline, so every timeout below
// would be advisory. Same reasoning and same shape as `ADB_KILL_SIGNAL`: `hdc` is
// a single-process client of a persistent shared daemon, so reaping the direct
// child is complete, and a group kill would wrongly take the daemon with it.
const HDC_KILL_SIGNAL = "SIGKILL" as const;

/**
 * Run `hdc` with the given argv. Returns the child's output whether it exited 0
 * or not — see the header: the exit code carries no signal, so classification is
 * left to `hdcFailure`. Only a spawn failure or a timeout kill rejects.
 */
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
    // Kind from what happened to the child, as `adb`'s wrapper reads it: a
    // client killed at its ceiling is a timeout, not a command that failed, and
    // the two want different answers from whoever reads the telemetry.
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
 * The `[Fail]…` line `hdc` printed, or null when it reported no transport error.
 *
 * Matched on the prefix rather than a substring so a remote command that merely
 * prints the token — a log line, a test name — cannot forge a transport failure.
 * Anchored at column 0 for the same reason: `hdc` writes `[Fail]…` flush left
 * (measured on 3.2.0d), while {@link runHdcShell} passes the REMOTE command's
 * own combined output through here, where an indented line is ordinary.
 */
export function hdcFailure(result: HdcRunResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const line = text.split(/\r?\n/).find((l) => l.startsWith(HDC_FAILURE_PREFIX));
  return line ? line.trim() : null;
}

/**
 * A diagnostic `hdc` printed without the `[Fail]` prefix, or null.
 *
 * The prefix does not cover everything. Measured on hdc 3.2.0d, a client that
 * cannot reach its server writes a bare `Connect server failed` to STDERR,
 * leaves stdout empty and exits 0 — so the prefix, the streams and the status
 * all miss it, and every caller reading only {@link hdcFailure} takes the empty
 * stdout at face value. Device-level errors carry the prefix; this one fails at
 * the connector, below it.
 *
 * Prose is told from output by its delimiters: `hdc`'s own tabular output is
 * tab-separated, and a bare connect key is one word. Neither is a line that
 * holds a space and no tab. Callers whose command has a positive success signal
 * should check that first — this only says what was printed instead.
 */
export function hdcProse(result: HdcRunResult): string | null {
  return (
    `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("[") && /\s/.test(l) && !l.includes("\t")) ?? null
  );
}

/**
 * Escape a string for interpolation into the single remote command line that
 * `hdc shell` hands to the device's `/bin/sh`.
 *
 * `hdc shell` takes a *command line*, not an argv — so every value that reaches
 * it (text to type, a bundle name, a file path) is shell metacharacter-bearing
 * input on a shell running as the `shell` user. POSIX single-quoting with the
 * `'\''` break is the only form that needs no escape table: verified through a
 * real device against `;`, backticks, `$`, both quote characters and non-ASCII.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface HdcShellResult {
  /** Everything the remote command wrote, with the status sentinel removed. */
  stdout: string;
  /** The remote command's own exit status, recovered via the sentinel. */
  exitCode: number;
}

/**
 * Run a command on the device and return its output *and its real exit status*.
 *
 * `command` is interpolated into a remote `/bin/sh` line verbatim — build it with
 * `shellQuote` around every caller-supplied value.
 *
 * Throws on a transport failure (unknown target, dead connection) so callers can
 * treat the result as "the command ran"; a non-zero `exitCode` then means the
 * command ran and failed, which is a different thing and theirs to interpret.
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
  // Scan from the end: the sentinel is the last thing echoed, and a command that
  // printed something resembling it earlier must not win over the real one.
  const idx = lines.findLastIndex((l) => l.trim().startsWith(`${RC_SENTINEL}=`));
  if (idx === -1) {
    // The device dropped the trailing echo — the command was killed on-device, or
    // the transport truncated. Either way the status is unknown, and reporting a
    // fabricated 0 here would turn a dead command into a silent success.
    //
    // A connector that never reached the device lands here too, and needs the
    // opposite repair, so the two are told apart by what came back: any output
    // at all means the command ran and was cut off, while an empty stdout is a
    // call that produced nothing — the shape an unprefixed `hdc` diagnostic has
    // (see {@link hdcProse}). Reading a truncated command's own output as that
    // diagnostic would quote the app back at the caller as hdc's verdict.
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

/**
 * What a completed transfer prints, measured on hdc 3.2.0d:
 *
 *   FileTransfer finish, Size:6, File count = 1, time:10ms rate:0.60kB/s
 *
 * Matched positively, because the absence of `[Fail]` does not mean the file
 * arrived: a client that cannot reach its server prints bare prose to stderr,
 * leaves stdout empty and exits 0 (see {@link hdcProse}), which read as success
 * hands the caller a path with nothing at it.
 */
const HDC_TRANSFER_OK = "FileTransfer finish";

/** Copy a file off the device. Throws with hdc's own diagnostic if it did not arrive. */
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
