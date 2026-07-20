import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// Absolute path to `ps`, resolved once. An MCP server launched from a GUI /
// launchd context inherits a sanitized PATH that omits `/bin`, so a bare `"ps"`
// spawn ENOENTs — the callers below swallow it, yielding an empty running-VVD set
// that silently defeats the VVD adb-shadow dedup in list-devices (VVD listed
// twice). Pin the canonical location; fall back to bare `"ps"` only if neither
// exists, preserving PATH resolution for an atypical layout.
export const PS_BIN = ["/bin/ps", "/usr/bin/ps"].find((p) => existsSync(p)) ?? "ps";

/**
 * Running VVD discovery from the OS process table: the `vega-virtual-device`
 * (legacy `kepler-virtual-device`) process is a positive Vega identity a stock
 * Android emulator / QEMU can't forge, and its console port is read off the live
 * argv (`-ports <console>,<adb>`).
 */

// `-A` (POSIX, all processes) + `-ww` (untruncated argv) are accepted by both
// macOS/BSD `ps` and Linux procps; the BSD `-x` form is not portable. `command=`
// (alias of `args` on procps) prints the full argv with no header.
export const PS_ARGS = ["-A", "-ww", "-o", "command="] as const;

// Same probe, with a leading PID column, for the stop/kill path: the `vega` CLI
// can lose track of a running VVD and refuse to stop it (see `stopVvd`), so we
// terminate the process directly. `pid=,command=` prints `<pid> <argv>` per line
// with no header on both macOS/BSD `ps` and Linux procps.
export const PS_ARGS_WITH_PID = ["-A", "-ww", "-o", "pid=,command="] as const;

// The VVD's emulator binary, anchored to a path boundary + a following arg/EOL so
// it can't match a substring like `…/vega-virtual-device-wrapper`.
const VVD_PROCESS_RE = /(?:^|\/)(?:vega|kepler)-virtual-device(?:\s|$)/;

/** Console ports of running VVDs from `ps` command-line output (pure; unit-tested). */
export function parseVvdConsolePorts(psOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of psOutput.split("\n")) {
    if (!VVD_PROCESS_RE.test(line)) continue;
    const port = consolePortFromVvdArgs(line);
    if (port !== null) ports.add(port);
  }
  return ports;
}

// Read the console port from the emulator's own `-ports <console>,<adb>` flag
// (fallback: the `-qmp …/qmp-socket-<console>.sock` path). Matching an actual flag
// — not just a loose `qmp-socket-NNNN.sock` substring — keeps a stray path in some
// other process's argv from contributing a phantom port.
function consolePortFromVvdArgs(line: string): number | null {
  const ports = line.match(/(?:^|\s)-ports\s+(\d+),\d+/);
  if (ports) return parseInt(ports[1]!, 10);
  const qmp = line.match(/(?:^|\s)-qmp\s+\S*qmp-socket-(\d+)\.sock/);
  if (qmp) return parseInt(qmp[1]!, 10);
  return null;
}

// Timeout for the `ps` process-table read. This is a LOCAL read (it never talks
// to a device), so it is near-instant in practice; the timeout is a backstop
// against a pathologically-loaded host, not a wedged device. Exported so
// list-devices' BRANCH_DEADLINE_MS accounting can include it: a single
// `listVegaDevices()` recovery can run two of these serially (the recovery gate
// plus the `-d emulator-<port>` selector probe), and that budget has to stay
// under the branch deadline so the backstop never truncates a completing branch.
export const VVD_PS_PROBE_TIMEOUT_MS = 5_000;

/**
 * PIDs of running VVD emulator processes from `ps -o pid=,command=` output
 * (pure; unit-tested). Same VVD identity as `parseVvdConsolePorts` — only the
 * pid (not the console port) is read, since the stop path kills by pid.
 */
export function parseVvdPids(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    // `<leading spaces><pid> <argv...>`; split the pid off, then identity-match argv.
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2]!;
    // Require BOTH the VVD binary name AND an emulator console-port signal
    // (`-ports`/`-qmp`). The pid feeds SIGTERM/SIGKILL, so demand a positive
    // emulator identity — otherwise a process that merely mentions a
    // `…/vega-virtual-device` path in its argv (e.g. a git command on a branch
    // of that name) could be mistaken for the device and signalled.
    if (!VVD_PROCESS_RE.test(argv) || consolePortFromVvdArgs(argv) === null) continue;
    pids.push(parseInt(m[1]!, 10));
  }
  return pids;
}

/**
 * Console ports of all running VVDs (empty if none / `ps` unavailable). `>1` ⇒
 * multiple VVDs — callers that target one surface `MultipleVegaDevicesError`.
 */
export async function listRunningVvdConsolePorts(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync(PS_BIN, [...PS_ARGS], {
      timeout: VVD_PS_PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseVvdConsolePorts(stdout);
  } catch (err) {
    // Don't fail every list-devices / Vega tool call if `ps` errors — but log it, so
    // a flag incompatibility (vs a genuine "no VVD") is diagnosable rather than silent.
    process.stderr.write(
      `[vega-process] ps probe failed; assuming no running VVD: ${String(err)}\n`
    );
    return new Set();
  }
}

/** PIDs of all running VVD emulator processes (empty if none / `ps` unavailable). */
export async function listRunningVvdPids(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(PS_BIN, [...PS_ARGS_WITH_PID], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseVvdPids(stdout);
  } catch (err) {
    process.stderr.write(
      `[vega-process] ps (pid) probe failed; cannot enumerate VVD pids: ${String(err)}\n`
    );
    return [];
  }
}
