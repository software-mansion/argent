import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type FailureKind,
  type FailureSignal,
} from "@argent/registry";
import { formatSubprocessFailure } from "./subprocess-error";
import { listRunningVvdConsolePorts, PS_BIN } from "./vega-process";
import { commandOnPath } from "./command-on-path";

const execFileAsync = promisify(execFile);

/**
 * Resolve the Vega CLI binary: `vega` on PATH, then its legacy `kepler` alias, then
 * `~/vega/bin/vega` (SDK default), so a host that ran the installer but never sourced
 * `~/vega/env` still works.
 *
 * Memoized with a short TTL, as in `android-binary.ts`: a *negative* result must not
 * stick for the process lifetime — sourcing `~/vega/env` or installing the SDK
 * mid-session should recover without restarting the long-lived tool-server.
 */
const VEGA_BINARY_TTL_MS = 60_000;
let cachedVegaBinary: { path: string | null; checkedAt: number } | undefined;

// X_OK, not F_OK: a non-executable file at the canonical `~/vega/bin/vega` is a partial
// SDK install; returning it would only produce an opaque EACCES at spawn.
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
    // A missing binary is classified upstream as TOOL_DEPENDENCY_MISSING: every tool path
    // preflights it (boot-device's ensureDep("vega"); the reinstall/launch/restart Vega
    // branches' requires:["vega"]) and the one non-tool caller, listVegaDevices, guards
    // with resolveVegaBinary() and degrades to []. So this throw never reaches the
    // telemetry boundary — a plain Error is enough.
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
 * Reap a spawned `vega`/`kepler` child AND its worker tree when the timeout fires.
 *
 * The CLI is a thin launcher that forks a `python3 dutyfree-vega → node → vda` worker
 * tree to talk to the device agent; against a wedged agent that tree hangs. `runVega`
 * spawns the launcher `detached`, making it a process-group leader, so one SIGKILL to the
 * *negative* pid reaps it and every descendant still in its group — instead of orphaning
 * the workers the way a bare `child.kill()` (only the direct child) does.
 *
 * A worker that `setsid()`s out of that group is unreachable by the group kill, but keeps
 * its *ppid* pointing at the launcher until the launcher dies. So snapshot the launcher's
 * descendants from the process table first and SIGKILL them individually — by pid, so a
 * concurrent `vega` call's workers are never touched. The group kill runs regardless of
 * whether the snapshot succeeds.
 *
 * We also destroy our ends of the stdio pipes first: a worker that inherited a dup of the
 * stdout write end would otherwise keep our read side from EOF-ing, leaving the `close`
 * await pending past the deadline.
 */
async function reapVegaGroup(child: ChildProcess): Promise<void> {
  child.stdout?.destroy();
  child.stderr?.destroy();
  const pid = child.pid;
  // A missing pid means spawn itself failed. The >1 guard keeps -0 / -1 out of
  // process.kill, which would broadcast to our own group / every process.
  if (pid == null || pid <= 1) return;
  // Snapshot while the launcher is still alive (see above); bounded so a slow or failed
  // `ps` can't delay the kills below.
  const descendants = await collectDescendantPids(pid).catch(() => [] as number[]);
  // Sweep the snapshot FIRST, before the group kill brings the launcher down: this is the
  // only way to reach a worker that setsid'd out of the group, and with no `await` between
  // the snapshot and these kills the pid-reuse window stays a synchronous burst rather
  // than spanning the group-kill cascade. A pid that already exited just throws ESRCH.
  for (const descendant of descendants) {
    if (descendant <= 1 || descendant === pid) continue;
    try {
      process.kill(descendant, VEGA_KILL_SIGNAL);
    } catch {
      // Already gone.
    }
  }
  // Then SIGKILL the launcher's whole process group — itself plus any same-group worker
  // the sweep didn't cover. Skip it once the launcher has exited: its pid (== pgid) can
  // then be recycled, so `-pid` could land on an unrelated group.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, VEGA_KILL_SIGNAL);
    } catch {
      // Group already gone; fall back to the bare child in case it outlived its group.
      try {
        child.kill(VEGA_KILL_SIGNAL);
      } catch {
        // Already dead — nothing to reap.
      }
    }
  }
}

/**
 * Descendant pids of `rootPid` from the OS process table (`ps` ppid edges), via a bounded
 * breadth-first walk. Lets reapVegaGroup reach a worker that escaped the launcher's
 * process group. Returns [] if `ps` is unavailable or times out — the group kill is the
 * primary mechanism; this is insurance.
 */
async function collectDescendantPids(rootPid: number): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(PS_BIN, ["-A", "-o", "pid=,ppid="], {
      timeout: 1_500,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    // `ps` unavailable / timed out — honor the documented [] contract.
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const childPid = parseInt(m[1]!, 10);
    const parentPid = parseInt(m[2]!, 10);
    const siblings = childrenByParent.get(parentPid);
    if (siblings) siblings.push(childPid);
    else childrenByParent.set(parentPid, [childPid]);
  }
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const childPid of childrenByParent.get(current) ?? []) {
      if (seen.has(childPid)) continue; // guard against a pid-reuse cycle
      seen.add(childPid);
      descendants.push(childPid);
      stack.push(childPid);
    }
  }
  return descendants;
}

/**
 * Live pids whose process-group id equals `pgid`, excluding the group-leader pid itself.
 * Returns [] if `ps` is unavailable.
 */
async function pgidMembers(pgid: number): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(PS_BIN, ["-A", "-o", "pid=,pgid="], {
      timeout: 1_500,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    return []; // `ps` unavailable / timed out — honor the documented [] contract.
  }
  const members: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const memberPid = parseInt(m[1]!, 10);
    const memberPgid = parseInt(m[2]!, 10);
    if (memberPgid === pgid && memberPid !== pgid) members.push(memberPid);
  }
  return members;
}

/**
 * Reap a worker still holding our stdout pipe open after the launcher's own *clean exit* —
 * the drain path (see VEGA_EXIT_DRAIN_GRACE_MS). reapVegaGroup can't help once the
 * launcher is gone: an outliving worker is reparented to init, so the ppid sweep finds
 * nothing, and the group kill is gated on the launcher being alive.
 *
 * A worker that merely *inherited* the pipe (the common case) stayed in the launcher's
 * process group, so its pgid still equals the launcher pid. Safety comes from the
 * call-site invariant: this runs ONLY from the drain timer, which fires precisely because
 * `close` never arrived — had the pipe-holder exited, the pipe would have EOF'd and
 * `close` would have cleared this timer. So the worker is still alive, and POSIX does not
 * recycle a pid as a pgid while any group member lives, so `-pid` provably targets our own
 * group. The membership snapshot is only a best-effort check that skips a pointless kill
 * when the worker raced to exit.
 *
 * A worker that `setsid()`d into its OWN group is out of reach here and left to exit on
 * its own: rare, and bounded at one leftover per finished call rather than the
 * accumulating wedged tree the timeout path reaps.
 */
async function reapLingeringGroupMembers(pid: number | undefined): Promise<void> {
  // As in reapVegaGroup: never pass -0 / -1 to process.kill.
  if (pid == null || pid <= 1) return;
  let members: number[];
  try {
    members = await pgidMembers(pid);
  } catch {
    return;
  }
  if (members.length === 0) return; // escaped the group, or already gone
  try {
    process.kill(-pid, VEGA_KILL_SIGNAL);
  } catch {
    // The last member exited between the snapshot and the kill — group already gone.
  }
}

/**
 * A guaranteed-live working directory for the spawned `vega`/`kepler` child. The
 * tool-server is a long-lived singleton; if its start directory is later removed (e.g. a
 * git worktree torn down mid-session), `process.cwd()` throws ENOENT and any child
 * inherits that dead cwd — the `vega` Python CLI then crashes in
 * `config.py find_workspace -> os.getcwd()`. adb-channel tools are immune (adb never
 * calls getcwd).
 *
 * Falls back to the OS temp dir so device-level `vega` commands, which don't need the
 * project workspace, keep working without a tool-server restart. Dependencies are
 * injected so a unit test can simulate a missing cwd.
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

function describeVegaFailure(args: string[], err: unknown, kindOverride?: FailureKind): Error {
  // Message format shared with adb via formatSubprocessFailure; the attached
  // FailureSignal keeps `vega`/`kepler` CLI failures classified for telemetry rather than
  // surfacing as unclassified 500s.
  const e = err as { signal?: string | null; killed?: boolean };
  const signal: FailureSignal = {
    error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
    failure_stage: "vega_cli_command",
    failure_area: "tool_server",
    // A forced reap shapes the error with killed=true so the message reads correctly, but
    // only a genuine *timeout* may classify as `error_kind: "timeout"` — listVegaDevices
    // keys its skip-the-recovery-call decision off that, so an overflow must not
    // masquerade as a wedged agent. Those callers pass an explicit kind.
    error_kind: kindOverride ?? (e.killed || e.signal ? "timeout" : "subprocess"),
    ...subprocessFailureMetadata(err, "vega"),
  };
  return new FailureError(formatSubprocessFailure("vega", args, err), signal);
}

// Cap collected output (mirrors execFile's `maxBuffer`) so a runaway child can't exhaust
// memory; overflow reaps the group and rejects. Applied per stream — like execFile,
// exceeding the cap on *either* stdout or stderr trips it. Measured in real UTF-8 bytes,
// not UTF-16 code units, so the cap means what it says.
const VEGA_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// After the child *exits*, `close` normally follows at once (its stdio EOFs). But a
// grandchild that inherited a dup of our stdout pipe keeps it open, delaying `close` even
// though the child already wrote everything. So give the buffered output this short grace
// to flush, then finish from the exit code anyway (destroying our read ends so the
// lingering worker can't hold us open). Without it a finished-but-pipe-held call would
// wait out the full `timeoutMs` and reject as a timeout, discarding output it already had.
const VEGA_EXIT_DRAIN_GRACE_MS = 1_000;

/**
 * Run the `vega`/`kepler` CLI directly. Callers that target a specific device must pass
 * `-d <serial>` (or `--device <serial>`) themselves via `args` — like `runAdb`, this does
 * not inject a serial; a serial-less call hits the single connected device or fails if
 * there are several.
 */
export async function runVega(
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<VegaRunResult> {
  const vegaPath = await resolveVegaOrThrow();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? VEGA_MAX_OUTPUT_BYTES;

  return new Promise<VegaRunResult>((resolve, reject) => {
    // `spawn`, not execFile, specifically for `detached: true` (execFile silently drops
    // it): it makes the child its own process-group leader, which is what lets
    // reapVegaGroup SIGKILL the entire `python3 → node → vda` worker tree on timeout.
    // cwd is pinned to a guaranteed-live dir (see resolveSpawnCwd).
    let child: ChildProcess;
    try {
      child = spawn(vegaPath, args, {
        cwd: resolveSpawnCwd(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(describeVegaFailure(args, err));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let reaped = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    // reapVegaGroup is async (it snapshots the process tree before killing); fire it at
    // most once — the timer and an overflow burst would otherwise stack redundant reaps —
    // and don't await it here.
    const reapOnce = (): void => {
      if (reaped) return;
      reaped = true;
      void reapVegaGroup(child);
    };

    // `timer`/`exitTimer` are declared below but only read from async callbacks, which
    // fire after this executor's synchronous body assigned `timer` — no temporal-dead-zone
    // access. `exitTimer` may still be undefined; clearTimeout(undefined) is a no-op.
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      run();
    };

    // The two forced-kill paths settle *the moment the condition is detected* rather than
    // on the child's later `close`, which only fires once reapVegaGroup has snapshotted the
    // process tree and brought the launcher down — settling on it would make a timed-out
    // call linger by the reap's duration. The reap still runs in the background; the
    // eventual `close` is a guarded no-op. stdout/stderr carry whatever arrived so far.
    const rejectTimeout = (): void =>
      // Shape like an execFile timeout rejection (killed=true) so it classifies as a
      // timeout downstream.
      settle(() =>
        reject(
          describeVegaFailure(
            args,
            Object.assign(new Error(`vega ${args.join(" ")} timed out after ${timeoutMs}ms`), {
              killed: true,
              signal: VEGA_KILL_SIGNAL,
              stdout,
              stderr,
            })
          )
        )
      );
    const rejectOverflow = (): void =>
      settle(() =>
        reject(
          describeVegaFailure(
            args,
            Object.assign(
              new Error(`vega ${args.join(" ")} output exceeded ${maxOutputBytes} bytes`),
              { killed: true, signal: VEGA_KILL_SIGNAL, stdout, stderr }
            ),
            // Force "subprocess": an overflow is a misbehaving child, not a wedged agent.
            // The killed=true shape would otherwise classify as "timeout" and wrongly
            // suppress the listVegaDevices recovery call.
            "subprocess"
          )
        )
      );

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk, "utf-8");
      if (!settled && stdoutBytes > maxOutputBytes) {
        reapOnce();
        rejectOverflow();
      }
    });
    // Cap stderr like stdout: execFile's `maxBuffer` killed the child when *either* stream
    // exceeded it, so a child that floods stderr must also reap+reject instead of growing
    // this buffer until it exhausts the long-lived tool-server's memory.
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      stderrBytes += Buffer.byteLength(chunk, "utf-8");
      if (!settled && stderrBytes > maxOutputBytes) {
        reapOnce();
        rejectOverflow();
      }
    });

    const timer = setTimeout(() => {
      reapOnce();
      rejectTimeout();
    }, timeoutMs);

    child.on("error", (err) => {
      // Spawn-level failure (e.g. ENOENT); err carries .code/.message for classification.
      settle(() => reject(describeVegaFailure(args, err)));
    });

    // Finish a child that ended on its own — a forced timeout/overflow kill settles before
    // we get here. Reached from `close` (the normal, fully-drained path) and, if a
    // pipe-holding grandchild delays `close` past the exit grace, from `exit` below.
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
      } else {
        // Mirror execFile's reject-on-failure so callers (e.g. listVegaDevices' try/catch)
        // see a failure. Classify "subprocess" explicitly: we reach here only when WE
        // didn't force the kill, so a terminating `signal` is external and must NOT
        // masquerade as a wedged-agent "timeout". No reaping needed here: `close` means
        // every stdio end EOF'd, and the exit-drain path already fired
        // reapLingeringGroupMembers.
        settle(() =>
          reject(
            describeVegaFailure(
              args,
              Object.assign(
                new Error(`vega ${args.join(" ")} exited with code ${code ?? "null"}`),
                {
                  code,
                  signal,
                  stdout,
                  stderr,
                }
              ),
              "subprocess"
            )
          )
        );
      }
    };

    // Prefer `close` (stdout/stderr fully drained), but fall back to `exit` plus a short
    // drain grace so a grandchild holding our stdout pipe open can't stall a finished call
    // into the timeout (see VEGA_EXIT_DRAIN_GRACE_MS).
    child.on("close", (code, signal) => finish(code, signal));
    child.on("exit", (code, signal) => {
      if (settled || exitTimer) return;
      // The child has terminated, so the wall-clock timeout is moot — only draining its
      // already-written output remains. Disarm the main timer so a clean exit whose `close`
      // is delayed past the deadline can't be rejected as a timeout, which would discard
      // valid output and suppress listVegaDevices' recovery. `exitTimer` is the sole
      // backstop from here.
      clearTimeout(timer);
      exitTimer = setTimeout(() => {
        // `close` didn't follow the exit within the grace — a worker is holding our stdout
        // pipe open. The child already wrote everything, so finish with what we have and
        // destroy our read ends so the worker can't keep us pending.
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Reap that worker if it stayed in the launcher's process group — the common
        // pipe-inheritance case, still safely reapable post-exit (see
        // reapLingeringGroupMembers). Fire-and-forget so it can't delay resolution.
        void reapLingeringGroupMembers(child.pid);
        finish(code, signal);
      }, VEGA_EXIT_DRAIN_GRACE_MS);
    });
  });
}

// `-d emulator-<port>` selector for the single running VVD, resolved from the OS process
// table (the authoritative running-VVD signal, shared with the adb channel).
//
// The `vega` CLI selects a device by its adb-transport serial (`emulator-<port>`), NOT by
// the `amazon-…` serial it prints in `device list`/`info` — passing the latter yields an
// empty "unknown" device. With no selector the CLI targets the sole connected device, but
// a stray `adb connect 127.0.0.1:<port+1>` adds a SECOND adb transport for the same VVD,
// after which an un-targeted call errors "Too many devices connected"
// (launch/terminate/install) or returns an empty device (info). Returns [] when there
// isn't exactly one running VVD, falling back to the CLI's own selection.
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
 * `-d emulator-<port>` so the call is unambiguous even when a stray `adb connect` added a
 * second adb transport for the same device. `device list` is the one subcommand that
 * rejects `-d` — callers that need it use `runVega` directly.
 */
export async function runVegaDevice(
  subcommand: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  const selector = await singleVvdSelector();
  return runVega(["device", ...subcommand, ...selector], options);
}

/**
 * Run `vega device <subcommand…>` against a device. `serial` is validated non-empty to
 * catch a caller that forgot to thread the udid; the actual target is resolved by
 * `runVegaDevice` (the running VVD's adb-transport serial), since the `vega` CLI does not
 * select by the `amazon-…` serial the udid carries.
 */
export async function vegaDevice(
  serial: string,
  subcommand: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaRunResult> {
  // Every real caller threads a non-empty `amazon-…` serial (Vega device classification
  // requires that prefix), so this can only trip a direct caller that forgot the udid —
  // never the registry/telemetry path, hence a plain Error without a code.
  if (!serial) throw new Error("vegaDevice requires a non-empty device serial");
  return runVegaDevice(subcommand, options);
}
