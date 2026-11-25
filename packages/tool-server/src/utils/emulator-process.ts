import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
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
 * - "free": nothing listens on it, as for a stale `offline` adb entry or an
 *   emulator still opening its console.
 * - "unknown": a probe failed this time (a timeout under load, a failed `ps`).
 *   The caller asks again rather than guess.
 * - "unavailable": this host offers no way to read the listener: Windows, or
 *   neither `lsof` nor a readable `/proc`. Only then may a caller fall back to
 *   weaker evidence, such as the AVD name the console reports.
 *
 * Where `lsof` is missing on Linux, as in a slim image, `/proc` answers instead.
 */
export async function consoleOwnership(serial: string, ownPid: number): Promise<ConsoleOwnership> {
  const port = serial.match(/^emulator-(\d+)$/)?.[1];
  if (port === undefined || process.platform === "win32") return "unavailable";
  let listener: number | "free" | "unseen";
  let parentOf: ((pid: number) => Promise<number | null>) | null = null;
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
    const e = err as { code?: unknown; killed?: boolean; stdout?: unknown };
    // lsof exits 1 and prints nothing when no process listens on the port.
    if (e.code === 1 && !e.killed && !e.stdout) return "free";
    if (e.code !== "ENOENT") return "unknown";
    if (process.platform !== "linux") return "unavailable";
    const fromProc = await procConsoleListener(parseInt(port, 10));
    if (fromProc === null) return "unavailable";
    listener = fromProc;
    parentOf = procParentPid;
  }
  if (listener === "free") return "free";
  // A listener whose process this user cannot inspect is not one this
  // tool-server spawned.
  if (listener === "unseen") return "other";
  if (listener === ownPid) return "own";
  if (parentOf === null) {
    const parents = await readParentPids();
    if (parents === null) return "unknown";
    return isDescendantOf(listener, ownPid, parents) ? "own" : "other";
  }
  const seen = new Set<number>();
  for (let p: number | null = listener; p !== null && p > 1 && !seen.has(p);) {
    if (p === ownPid) return "own";
    seen.add(p);
    p = await parentOf(p);
  }
  return "other";
}

export type ConsoleOwnership = "own" | "other" | "free" | "unknown" | "unavailable";

/**
 * The inodes of the sockets listening on TCP `port`, from the text of
 * `/proc/net/tcp` or `/proc/net/tcp6`: hex `address:port` in the second
 * column, state `0A` (LISTEN) in the fourth, the inode in the tenth.
 */
export function parseProcNetTcpListeners(text: string, port: number): string[] {
  const inodes: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    const localPort = f[1]?.split(":").pop();
    if (f[3] !== "0A" || localPort === undefined || f[9] === undefined || f[9] === "0") continue;
    if (parseInt(localPort, 16) === port) inodes.push(f[9]);
  }
  return inodes;
}

/**
 * The pid listening on TCP `port`, read from `/proc`: "free" when no socket
 * listens on it, "unseen" when one does but belongs to a process this user
 * cannot inspect, null when `/proc` cannot be read.
 */
async function procConsoleListener(port: number): Promise<number | "free" | "unseen" | null> {
  const inodes = new Set<string>();
  let read = false;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const i of parseProcNetTcpListeners(await readFile(table, "utf8"), port)) inodes.add(i);
      read = true;
    } catch {
      // tcp6 is absent without IPv6.
    }
  }
  if (!read) return null;
  if (inodes.size === 0) return "free";
  const targets = new Set([...inodes].map((i) => `socket:[${i}]`));
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      if (targets.has(link)) return parseInt(pid, 10);
    }
  }
  return "unseen";
}

/** The parent of `pid` from `/proc/<pid>/stat`, or null once it is gone. */
async function procParentPid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name in parentheses can hold spaces, so split after it.
    const ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    return ppid === undefined ? null : parseInt(ppid, 10);
  } catch {
    return null;
  }
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
