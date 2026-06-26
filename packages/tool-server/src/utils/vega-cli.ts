import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type FailureSignal,
} from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";
import { listRunningVvdConsolePorts } from "./vega-process";
import { commandOnPath } from "./command-on-path";

const execFileAsync = promisify(execFile);

/**
 * Resolve the Vega CLI binary (`vega`, or its `kepler` alias). Mirrors how
 * `android-binary.ts` resolves `adb`: prefer whatever is on PATH, then fall
 * back to the SDK's default install location so a host that ran the Vega
 * installer but never sourced `~/vega/env` still works.
 *
 *   1. `vega` on PATH            — the common case after `source ~/vega/env`
 *   2. `kepler` on PATH          — legacy alias (symlink to the same binary)
 *   3. `~/vega/bin/vega`         — SDK default install location
 *
 * Result is memoized with a short TTL (mirroring `android-binary.ts`): a positive
 * result effectively never expires within a session, but a *negative* one must
 * not stick for the process lifetime — a user who sources `~/vega/env` or installs
 * the SDK mid-session should recover without restarting the long-lived tool-server.
 */
const VEGA_BINARY_TTL_MS = 60_000;
let cachedVegaBinary: { path: string | null; checkedAt: number } | undefined;

// X_OK, not F_OK (mirrors android-binary.ts): a present-but-non-executable file at
// the canonical `~/vega/bin/vega` path is a partial/corrupt SDK install. Returning
// it would only produce an opaque EACCES at spawn, so prefer the not-found message.
async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveVegaBinary(): Promise<string | null> {
  const now = Date.now();
  if (cachedVegaBinary && now - cachedVegaBinary.checkedAt < VEGA_BINARY_TTL_MS) {
    return cachedVegaBinary.path;
  }
  const onPath = (await commandOnPath("vega")) ?? (await commandOnPath("kepler"));
  const fallback = join(homedir(), "vega", "bin", "vega");
  const path = onPath ?? ((await isExecutable(fallback)) ? fallback : null);
  cachedVegaBinary = { path, checkedAt: now };
  return path;
}

/** Test-only: clear the binary-resolution memo. */
export function __resetVegaBinaryCacheForTests(): void {
  cachedVegaBinary = undefined;
}

async function resolveVegaOrThrow(): Promise<string> {
  const path = await resolveVegaBinary();
  if (!path) {
    throw new Error(
      "`vega` (or `kepler`) not found on PATH or under `~/vega/bin`. " +
        "Install the Vega SDK and run `source ~/vega/env`, then retry."
    );
  }
  return path;
}

export interface VegaRunResult {
  stdout: string;
  stderr: string;
}

// As with adb, a hung `vega` child can ignore SIGTERM (it shells out to the
// device agent), so force the kill at the timeout boundary.
const VEGA_KILL_SIGNAL = "SIGKILL" as const;

/**
 * Resolve a guaranteed-live working directory for the spawned `vega`/`kepler`
 * child. The tool-server is a long-lived singleton; if it was started from a
 * directory that is later removed (e.g. a git worktree torn down mid-session),
 * `process.cwd()` itself throws ENOENT and any child inherits that dead cwd —
 * the `vega` Python CLI then crashes in `config.py find_workspace -> os.getcwd()`
 * with "getcwd: cannot access parent directories". adb-channel tools are immune
 * (adb never calls getcwd), which is why only the CLI-backed Vega tools hit this.
 *
 * Validate the server's cwd and fall back to the OS temp dir (always present) so
 * device-level `vega` commands — which don't need the project workspace — keep
 * working without a full tool-server restart. Dependencies are injected so a unit
 * test can simulate a missing cwd.
 */
export function resolveSpawnCwd(
  getCwd: () => string = () => process.cwd(),
  dirExists: (p: string) => boolean = existsSync,
  fallback: string = tmpdir()
): string {
  try {
    const cwd = getCwd();
    if (dirExists(cwd)) return cwd;
  } catch {
    // process.cwd() throws when the directory was removed under the server.
  }
  return fallback;
}

function describeVegaFailure(args: string[], err: unknown): Error {
  // Shares the message format with adb (stderr/stdout first, then a
  // signal/killed/code fallback) via formatSubprocessFailure, and — like adb —
  // attaches a FailureSignal so `vega`/`kepler` CLI failures are classified for
  // telemetry rather than surfacing as unclassified 500s.
  const e = err as { signal?: string | null; killed?: boolean };
  const signal: FailureSignal = {
    error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
    failure_stage: "vega_cli_command",
    failure_area: "tool_server",
    error_kind: e.killed || e.signal ? "timeout" : "subprocess",
    ...subprocessFailureMetadata(err, "vega"),
  };
  return new FailureError(formatSubprocessFailure("vega", args, err), signal);
}

/**
 * Run the `vega`/`kepler` CLI directly. Callers that target a specific device
 * must pass `-d <serial>` (or `--device <serial>`) themselves via `args` — like
 * `runAdb`, this does not inject a serial; a serial-less call hits the single
 * connected device or fails if there are several.
 */
export async function runVega(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  const vegaPath = await resolveVegaOrThrow();
  try {
    const { stdout, stderr } = await execFileAsync(vegaPath, args, {
      // Pin to a guaranteed-live cwd so a since-deleted server cwd doesn't crash
      // the `vega` CLI in os.getcwd() (see resolveSpawnCwd).
      cwd: resolveSpawnCwd(),
      timeout: options.timeoutMs ?? 60_000,
      killSignal: VEGA_KILL_SIGNAL,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
    });
    return { stdout, stderr };
  } catch (err) {
    throw describeVegaFailure(args, err);
  }
}

// `-d emulator-<port>` selector for the single running VVD, resolved from the OS
// process table (the authoritative running-VVD signal, shared with the adb channel).
//
// The `vega` CLI selects a device by its adb-transport serial (`emulator-<port>`),
// NOT by the `amazon-…` serial it prints in `device list`/`info` — passing the latter
// yields an empty "unknown" device (verified on a live VVD). With no selector the CLI
// targets the sole connected device, but a stray `adb connect 127.0.0.1:<port+1>` adds
// a SECOND adb transport for the same VVD, after which an un-targeted call errors
// "Too many devices connected" (launch/terminate/install) or returns an empty device
// (info). Pinning `-d emulator-<port>` is correct in both the single- and dual-transport
// states. Returns [] when there isn't exactly one running VVD, so a no-VVD / multi-VVD
// call falls back to the CLI's own selection (or its own erroring).
async function singleVvdSelector(): Promise<string[]> {
  let ports: Set<number>;
  try {
    ports = await listRunningVvdConsolePorts();
  } catch {
    return [];
  }
  return ports.size === 1 ? ["-d", `emulator-${[...ports][0]!}`] : [];
}

/**
 * Run `vega device <subcommand…>` against the single running VVD, pinned with
 * `-d emulator-<port>` so the call is unambiguous even when a stray `adb connect`
 * has added a second adb transport for the same device. `device list` is the one
 * subcommand that rejects `-d` — callers that need it use `runVega` directly.
 */
export async function runVegaDevice(
  subcommand: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  const selector = await singleVvdSelector();
  return runVega(["device", ...subcommand, ...selector], options);
}

/**
 * Run `vega device <subcommand…>` against a device. `serial` is validated non-empty
 * to catch a caller that forgot to thread the udid; the actual target is resolved by
 * `runVegaDevice` (the running VVD's adb-transport serial), since the `vega` CLI does
 * not select by the `amazon-…` serial the udid carries.
 */
export async function vegaDevice(
  serial: string,
  subcommand: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  if (!serial) throw new Error("vegaDevice requires a non-empty device serial");
  return runVegaDevice(subcommand, options);
}
