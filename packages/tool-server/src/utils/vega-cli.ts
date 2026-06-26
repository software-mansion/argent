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
import { listRunningVvdConsolePorts } from "./vega-process";

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

async function commandOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
      timeout: 2_000,
    });
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
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
    throw new FailureError(
      "`vega` (or `kepler`) not found on PATH or under `~/vega/bin`. " +
        "Install the Vega SDK and run `source ~/vega/env`, then retry.",
      {
        error_code: FAILURE_CODES.VEGA_CLI_NOT_FOUND,
        failure_stage: "vega_binary_resolve",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "vega",
      }
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
 * The CLI is a thin launcher that forks a `python3 dutyfree-vega → node → vda`
 * worker tree to talk to the device agent; against a wedged agent that tree hangs.
 * `runVega` spawns the launcher with `detached: true`, making it a process-group
 * leader, so a single SIGKILL to the *negative* pid reaps the launcher and every
 * descendant that stayed in its group — instead of orphaning the `dutyfree-vega`/
 * `vda` workers the way a bare `child.kill()` (which reaches only the direct child)
 * did.
 *
 * Belt-and-suspenders for a worker that `setsid()`s out of the launcher's group
 * (its pgid then differs, so the group SIGKILL can't reach it — the failure mode an
 * earlier investigation reported against a wedged VVD): BEFORE killing, snapshot the
 * launcher's descendants from the process table. A setsid'd worker keeps its *ppid*
 * pointing at the launcher until the launcher dies, so a ppid tree-walk still reaches
 * it while the launcher is alive; we SIGKILL those pids individually *first* — before
 * the group kill brings the launcher down — so the snapshot is acted on while it is
 * freshest (minimizing any pid-reuse window), then group-kill the launcher. The
 * snapshot is precise — only this launcher's own descendants, identified by pid, so a
 * concurrent `vega` call's workers are never touched (no `pkill`-style pattern match)
 * — and bounded, and the group kill runs regardless of whether the snapshot succeeds.
 *
 * We also destroy our ends of the stdio pipes first: a worker that inherited a dup
 * of the stdout write end could otherwise keep our read side from EOF-ing, leaving
 * the `close` await pending past the deadline (the observed "blocks for the full
 * timeout even though the data was ready" freeze).
 */
async function reapVegaGroup(child: ChildProcess): Promise<void> {
  child.stdout?.destroy();
  child.stderr?.destroy();
  const pid = child.pid;
  // pid is a real OS pid (>1) for any spawned child; a missing pid means spawn
  // itself failed, so there's nothing to reap. Guard so we never pass -0 / -1 to
  // process.kill (which would broadcast to the whole process group / every process).
  if (pid == null || pid <= 1) return;
  // Snapshot descendants while the launcher is still alive (see above); best-effort
  // and bounded so a slow/failed `ps` can't delay the kills below.
  const descendants = await collectDescendantPids(pid).catch(() => [] as number[]);
  // Sweep the snapshotted descendants FIRST — before the group kill brings the
  // launcher down. This reaps a worker that setsid'd out of the launcher's group (the
  // group SIGKILL can't reach it), and doing it now — launcher still alive, pids just
  // read, no `await` between the snapshot and these kills — keeps the pid-reuse window
  // to a synchronous burst rather than spanning the group-kill cascade, during which a
  // same-group descendant could exit and have its pid recycled. A pid that already
  // exited just throws ESRCH.
  for (const descendant of descendants) {
    if (descendant <= 1 || descendant === pid) continue;
    try {
      process.kill(descendant, VEGA_KILL_SIGNAL);
    } catch {
      // Already gone.
    }
  }
  // Then SIGKILL the whole process group led by the detached launcher — reaps the
  // launcher itself and any same-group worker the descendant sweep didn't cover.
  // Skip it once the launcher has already exited (exitCode/signalCode set by Node):
  // the descendant snapshot above already swept its tree, and once the launcher is
  // gone its pid (== pgid) can be recycled, so a `-pid` group kill could land on an
  // unrelated process group. While the launcher is alive its pgid is still ours.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      // Negative pid → signal the whole process group led by the detached launcher.
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
 * Descendant pids of `rootPid` from the OS process table (`ps` ppid edges), via a
 * bounded breadth-first walk. Lets reapVegaGroup reach a worker that escaped the
 * launcher's process group. Returns [] if `ps` is unavailable or times out (the
 * group kill is the primary mechanism; this is insurance).
 */
async function collectDescendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
    timeout: 1_500,
    maxBuffer: 16 * 1024 * 1024,
  });
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
 * Live pids whose process-group id equals `pgid` (excluding the group-leader pid
 * itself). Used by reapLingeringGroupMembers; returns [] if `ps` is unavailable.
 */
async function pgidMembers(pgid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,pgid="], {
    timeout: 1_500,
    maxBuffer: 16 * 1024 * 1024,
  });
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
 * Reap a worker still holding our stdout pipe open after the launcher's *own clean
 * exit* — the exit-drain path (see VEGA_EXIT_DRAIN_GRACE_MS). reapVegaGroup can't help
 * once the launcher is gone: its ppid descendant sweep returns nothing (an outliving
 * worker is immediately reparented to init — its ppid is 1, verified empirically), and
 * its group kill is gated on the launcher still being alive.
 *
 * But a worker that merely *inherited* our pipe (the common case) stayed in the
 * launcher's process group, so its pgid still equals the launcher pid — and it is
 * reapable here. The safety guarantee is the *call-site invariant*, not the snapshot in
 * isolation: this runs ONLY from the drain timer, which fires precisely because `close`
 * never arrived within the grace; had the pipe-holding worker exited, the pipe would have
 * EOF'd and `close` would have settled + cleared this timer. So when we run, that worker
 * is still alive — and POSIX does not recycle a pid as a pgid while any member of its
 * group lives, so the launcher pid cannot have been recycled into an unrelated group's
 * pgid: `-pid` provably targets only our own group. SIGKILLing it reaps the worker
 * (verified empirically). The membership snapshot is a best-effort secondary check that
 * skips a pointless `-pid` when the worker raced to exit just before it; the only residual
 * is the snapshot→kill window (tens of ms, no `await` between), the same pid-reuse class
 * collectDescendantPids' sweep already accepts.
 *
 * A worker that `setsid()`d into its OWN group escaped here (group `pid` is empty); having
 * outlived the launcher it has no live handle and is left to exit on its own. That case
 * is rare — a clean exit whose grandchild both escaped the group AND outlived it — and
 * bounded (one leftover per finished call, not the accumulating wedged tree the timeout
 * path reaps). Best-effort throughout: a slow/failed `ps` just skips the reap.
 */
async function reapLingeringGroupMembers(pid: number | undefined): Promise<void> {
  // pid > 1 guard mirrors reapVegaGroup: never pass -0 / -1 to process.kill (which would
  // broadcast to the whole process group / every process).
  if (pid == null || pid <= 1) return;
  let members: number[];
  try {
    members = await pgidMembers(pid);
  } catch {
    return; // `ps` unavailable — best-effort, skip.
  }
  if (members.length === 0) return; // group empty (escaped/already gone) — nothing to reap.
  try {
    process.kill(-pid, VEGA_KILL_SIGNAL);
  } catch {
    // The last member exited between the snapshot and the kill — group already gone.
  }
}

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

function describeVegaFailure(args: string[], err: unknown, kindOverride?: FailureKind): Error {
  // Shares the message format with adb (stderr/stdout first, then a
  // signal/killed/code fallback) via formatSubprocessFailure, and — like adb —
  // attaches a FailureSignal so `vega`/`kepler` CLI failures are classified for
  // telemetry rather than surfacing as unclassified 500s.
  const e = err as { signal?: string | null; killed?: boolean };
  const signal: FailureSignal = {
    error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
    failure_stage: "vega_cli_command",
    failure_area: "tool_server",
    // A timeout/overflow reap shapes the error with killed=true so the message reads
    // correctly, but only a genuine *timeout* should classify as `error_kind:
    // "timeout"` — listVegaDevices keys its skip-the-recovery-call decision off that,
    // so an overflow (or other forced kill) must NOT masquerade as a wedged-agent
    // timeout. Those callers pass an explicit kind; everything else uses the heuristic.
    error_kind: kindOverride ?? (e.killed || e.signal ? "timeout" : "subprocess"),
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
// Cap collected output (mirrors the old execFile `maxBuffer`) so a runaway child
// can't exhaust memory; overflow reaps the group and rejects. Applied per stream —
// like execFile, exceeding the cap on *either* stdout or stderr trips it. Measured in
// real UTF-8 bytes (not string length / UTF-16 code units) so the cap means what it says.
const VEGA_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// After the child *exits*, `close` normally follows at once (its stdio EOFs) and we
// finish there with fully-drained output. But a grandchild that inherited a dup of
// our stdout pipe keeps it open, delaying `close` even though the child already wrote
// everything — the pipe-inheritance freeze. So once the child has exited we give the
// buffered output this short grace to flush, then finish from the exit code anyway
// (destroying our read ends so the lingering worker can't hold us open). Without it a
// finished-but-pipe-held call would wait out the full `timeoutMs` and reject as a
// timeout, discarding the output it already had. The child has stopped writing by
// then, so the pending bytes are already in the OS pipe buffer and flush in well under
// this window.
const VEGA_EXIT_DRAIN_GRACE_MS = 1_000;

export async function runVega(
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<VegaRunResult> {
  const vegaPath = await resolveVegaOrThrow();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? VEGA_MAX_OUTPUT_BYTES;

  return new Promise<VegaRunResult>((resolve, reject) => {
    // `spawn` (not execFile) specifically so we can pass `detached: true` —
    // execFile silently drops it. detached makes the child its own process-group
    // leader, which is what lets reapVegaGroup SIGKILL the entire
    // `python3 → node → vda` worker tree on timeout rather than orphaning it.
    // cwd is pinned to a guaranteed-live dir so a since-deleted server cwd doesn't
    // crash the `vega` CLI in os.getcwd() (see resolveSpawnCwd).
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

    // reapVegaGroup is async (it snapshots the process tree before killing); fire it
    // at most once and don't await it here. Guarding prevents the timer and an
    // overflow burst from launching redundant reaps.
    const reapOnce = (): void => {
      if (reaped) return;
      reaped = true;
      void reapVegaGroup(child);
    };

    // `settle` reads `timer`/`exitTimer` (declared/assigned below): the bindings are
    // captured by closure and only ever read from async callbacks, which fire after
    // this executor's synchronous body has assigned `timer`, so there's no
    // temporal-dead-zone access. `exitTimer` may still be undefined (no exit yet) —
    // clearTimeout(undefined) is a no-op.
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      run();
    };

    // The two forced-kill paths settle the promise *the moment the condition is
    // detected*, rather than waiting for the child's later `close`. `close` only
    // fires once reapVegaGroup has snapshotted the process tree (`ps`) and brought
    // the launcher down, so settling on it would make a timed-out/overflowed call
    // linger by the reap's duration. The reap still runs in the background; the
    // eventual `close` is a guarded no-op. stdout/stderr carry whatever arrived so far.
    const rejectTimeout = (): void =>
      // Shape like an execFile timeout rejection (killed=true) so it classifies as a
      // timeout downstream — listVegaDevices keys its skip-the-recovery decision off it.
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
            // Force "subprocess": an overflow is a misbehaving child, not a wedged
            // agent. Without this the killed=true shape would classify as "timeout"
            // and wrongly suppress the listVegaDevices recovery call.
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
    // Cap stderr the same way as stdout: execFile's `maxBuffer` killed the child when
    // *either* stream exceeded it, so a child that floods stderr (rather than stdout)
    // must also reap+reject instead of growing this buffer unbounded — otherwise a
    // misbehaving CLI could exhaust the long-lived tool-server's memory before the
    // timeout fires.
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
      // Spawn-level failure (e.g. ENOENT); err carries .code/.message so
      // describeVegaFailure / subprocessFailureMetadata classify it correctly.
      settle(() => reject(describeVegaFailure(args, err)));
    });

    // Finish a child that ended on its own (NOT a forced timeout/overflow kill — those
    // settle before we get here): resolve on a clean exit, reject otherwise. Reached
    // from `close` (the normal, fully-drained path) and — if a pipe-holding grandchild
    // delays `close` past the exit grace — from the `exit` fallback below.
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
      } else {
        // Non-zero exit (or a terminating signal) — mirror execFile's reject-on-
        // failure so callers (e.g. listVegaDevices' try/catch) see a failure, with
        // code/signal/io attached for the message. Classify "subprocess" explicitly:
        // this path is reached only when WE didn't force the kill (timeout/overflow
        // settle first), so a terminating `signal` here is external and must NOT
        // masquerade as a wedged-agent "timeout" (which would wrongly suppress the
        // listVegaDevices recovery call). `finish` itself does no reaping: on the normal
        // `close` path none is needed (`close` means every stdio end EOF'd, so no worker
        // still holds the pipe), and on the exit-drain fallback the caller already kicked
        // off reapLingeringGroupMembers before invoking us.
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

    // The forced-kill paths (timeout / overflow) settle the promise themselves, so by
    // the time `close`/`exit` fire for them they're guarded no-ops. We prefer `close`
    // (stdout/stderr fully drained) but fall back to `exit` + a short drain grace so a
    // grandchild holding our stdout pipe open can't stall a finished call into the
    // timeout (see VEGA_EXIT_DRAIN_GRACE_MS).
    child.on("close", (code, signal) => finish(code, signal));
    child.on("exit", (code, signal) => {
      if (settled || exitTimer) return;
      // The child has terminated, so the wall-clock timeout is now moot — only draining
      // its already-written output remains. Disarm the main timer so a clean exit whose
      // `close` is delayed past the deadline (a grandchild holding the stdout pipe open)
      // can't be rejected AS A TIMEOUT before the drain grace below fires — which would
      // discard valid output and mis-classify it `error_kind: "timeout"`, suppressing
      // listVegaDevices' recovery. From here `exitTimer` (bounded) is the sole backstop.
      clearTimeout(timer);
      exitTimer = setTimeout(() => {
        // `close` didn't follow the exit within the grace — a worker is holding our
        // stdout pipe open. The child already wrote everything, so finish with what we
        // have and destroy our read ends so the lingering worker can't keep us pending.
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Reap that worker if it stayed in the launcher's process group (the common
        // pipe-inheritance case — still safely reapable post-exit because a live group
        // member pins the pgid; see reapLingeringGroupMembers). Fire-and-forget so it
        // can't delay resolution; a worker that escaped into its own group is left to
        // exit on its own (rare, bounded — see the function doc).
        void reapLingeringGroupMembers(child.pid);
        finish(code, signal);
      }, VEGA_EXIT_DRAIN_GRACE_MS);
    });
  });
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
  if (!serial)
    throw new FailureError("vegaDevice requires a non-empty device serial", {
      error_code: FAILURE_CODES.VEGA_DEVICE_ID_INVALID,
      failure_stage: "vega_device_serial_required",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  return runVegaDevice(subcommand, options);
}
