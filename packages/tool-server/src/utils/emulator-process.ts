import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { PS_ARGS_WITH_PID, PS_BIN } from "./vega-process";

const execFileAsync = promisify(execFile);

/**
 * Running Android emulators from the OS process table, by AVD. adb cannot name
 * the AVD of an emulator that is shutting down or still coming up (getprop fails
 * and the console does not answer), but the process keeps its `-avd <name>`
 * (or `@<name>`) argument until it exits.
 */

// The qemu binary the `emulator` launcher execs into
// (`…/qemu/darwin-aarch64/qemu-system-aarch64`), or the launcher itself on
// builds where it stays the parent. Anchored to a path boundary and a following
// argument so a process that merely mentions such a path does not count.
const EMULATOR_PROCESS_RE = /(?:^|\/)(?:qemu-system-[\w-]+|emulator|emulator64-[\w-]+)\s/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * PIDs of the emulator processes running `avdName`, from `ps -o pid=,command=`
 * output. The AVD is named by `-avd <name>` or by the short `@<name>` form,
 * which the qemu process keeps in its argv as given. Either has to match as a
 * whole argument: `Pixel_7` must not match an emulator running `Pixel_7_API_34`.
 */
export function parseEmulatorPidsForAvd(psOutput: string, avdName: string): number[] {
  return parseEmulatorProcessesForAvd(psOutput, avdName).map((p) => p.pid);
}

/** One emulator process running an AVD, with the launch flags argent tells instances apart by. */
export interface EmulatorProcess {
  pid: number;
  /** Launched with `-read-only`: it holds no AVD lock and saves no snapshot. */
  readOnly: boolean;
  /** The console port from `-port <n>`, or null when the emulator picked one itself. */
  port: number | null;
}

/** Like {@link parseEmulatorPidsForAvd}, with each process's `-read-only` and `-port` flags. */
export function parseEmulatorProcessesForAvd(psOutput: string, avdName: string): EmulatorProcess[] {
  const avdArg = new RegExp(`(?:^|\\s)(?:-avd\\s+|@)${escapeRegExp(avdName)}(?:\\s|$)`);
  const processes: EmulatorProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2]!;
    if (!EMULATOR_PROCESS_RE.test(argv) || !avdArg.test(argv)) continue;
    const port = argv.match(/(?:^|\s)-port\s+(\d+)(?:\s|$)/);
    processes.push({
      pid: parseInt(m[1]!, 10),
      readOnly: /(?:^|\s)-read-only(?:\s|$)/.test(argv),
      port: port ? parseInt(port[1]!, 10) : null,
    });
  }
  return processes;
}

/**
 * PIDs of the emulator processes running `avdName` (empty if none, or if `ps`
 * is unavailable, as on Windows).
 */
export async function listEmulatorPidsForAvd(avdName: string): Promise<number[]> {
  return (await listEmulatorProcessesForAvd(avdName)).map((p) => p.pid);
}

/**
 * The emulator processes running `avdName`, with their `-read-only` and `-port`
 * flags (empty if none, or if `ps` is unavailable, as on Windows).
 */
export async function listEmulatorProcessesForAvd(avdName: string): Promise<EmulatorProcess[]> {
  return (await readEmulatorProcessesForAvd(avdName)) ?? [];
}

/**
 * Like {@link listEmulatorProcessesForAvd}, but null when the process table
 * cannot be read (Windows, or `ps` failed or timed out), so a caller can tell
 * "no such emulator" from "unknown".
 */
export async function readEmulatorProcessesForAvd(
  avdName: string
): Promise<EmulatorProcess[] | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync(PS_BIN, [...PS_ARGS_WITH_PID], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseEmulatorProcessesForAvd(stdout, avdName);
  } catch (err) {
    process.stderr.write(
      `[emulator-process] ps probe failed; cannot list the emulators of "${avdName}": ${String(err)}\n`
    );
    return null;
  }
}

// `lsof` lives in `/usr/sbin` on macOS, outside a launchd PATH, as `ps` can be.
const LSOF_BIN = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => existsSync(p)) ?? "lsof";

/**
 * Whether the emulator behind `serial` is the process `ownPid` or one of its
 * descendants. An emulator listens on its console port, the number in its
 * serial. Several instances of one read-only AVD can come up at once, and the
 * consoles of all of them name the same AVD, so the listener is the only proof
 * of which one a spawn started.
 *
 * "free" when nothing listens on it, as for a stale `offline` adb entry or an
 * emulator still opening its console. "unknown" when it cannot be read: on
 * Windows, without `lsof` or `ps`, or when a probe fails.
 */
export async function consoleOwnership(
  serial: string,
  ownPid: number
): Promise<"own" | "other" | "free" | "unknown"> {
  const port = serial.match(/^emulator-(\d+)$/)?.[1];
  if (port === undefined || process.platform === "win32") return "unknown";
  let listener: number;
  try {
    const { stdout } = await execFileAsync(
      LSOF_BIN,
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { timeout: 3_000 }
    );
    const pid = stdout.match(/^p(\d+)$/m)?.[1];
    // A zero exit names a listener; output without one is no answer.
    if (pid === undefined) return "unknown";
    listener = parseInt(pid, 10);
  } catch (err) {
    // lsof exits 1 and prints nothing when no process listens on the port.
    const e = err as { code?: unknown; killed?: boolean; stdout?: unknown };
    return e.code === 1 && !e.killed && !e.stdout ? "free" : "unknown";
  }
  if (listener === ownPid) return "own";
  const parents = await readParentPids();
  if (parents === null) return "unknown";
  return isDescendantOf(listener, ownPid, parents) ? "own" : "other";
}

/** Each process's parent, from `ps -o pid=,ppid=` output. */
export function parseParentPids(psOutput: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m) parents.set(parseInt(m[1]!, 10), parseInt(m[2]!, 10));
  }
  return parents;
}

/** Whether `pid` is `ancestor` or below it in the process tree. */
export function isDescendantOf(
  pid: number,
  ancestor: number,
  parents: Map<number, number>
): boolean {
  const seen = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 1 && !seen.has(p);) {
    if (p === ancestor) return true;
    seen.add(p);
    p = parents.get(p);
  }
  return false;
}

async function readParentPids(): Promise<Map<number, number> | null> {
  try {
    const { stdout } = await execFileAsync(PS_BIN, ["-A", "-o", "pid=,ppid="], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseParentPids(stdout);
  } catch {
    return null;
  }
}
