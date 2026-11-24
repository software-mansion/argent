import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// Absolute `ps`, resolved once: an MCP server launched from a GUI / launchd context
// inherits a PATH without `/bin`, so a bare `"ps"` ENOENTs — and the callers below
// swallow that into an empty running-VVD set, defeating list-devices' VVD adb-shadow
// dedup (the VVD is then listed twice). Bare `"ps"` only if neither path exists.
export const PS_BIN = ["/bin/ps", "/usr/bin/ps"].find((p) => existsSync(p)) ?? "ps";

/**
 * Running-VVD discovery from the OS process table: a `vega-virtual-device` (legacy
 * `kepler-virtual-device`) process is a Vega identity a stock Android emulator / QEMU
 * can't forge, and its console port is read off the live argv.
 */

// `-A` (all processes) + `-ww` (untruncated argv) work on both macOS/BSD `ps` and Linux
// procps; the BSD `-x` form does not. `command=` prints the full argv with no header.
export const PS_ARGS = ["-A", "-ww", "-o", "command="] as const;

// Same probe with a leading PID column, for the stop/kill path: the `vega` CLI can lose
// track of a running VVD and refuse to stop it (see `stopVvd`), so we kill by pid.
// `pid=,command=` is header-less on both macOS/BSD `ps` and Linux procps.
export const PS_ARGS_WITH_PID = ["-A", "-ww", "-o", "pid=,command="] as const;

// Anchored to a path boundary + a following arg/EOL so it can't match a substring like
// `…/vega-virtual-device-wrapper`.
const VVD_PROCESS_RE = /(?:^|\/)(?:vega|kepler)-virtual-device(?:\s|$)/;

/** Console ports of running VVDs from `ps` command-line output. */
export function parseVvdConsolePorts(psOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of psOutput.split("\n")) {
    if (!VVD_PROCESS_RE.test(line)) continue;
    const port = consolePortFromVvdArgs(line);
    if (port !== null) ports.add(port);
  }
  return ports;
}

// Console port from the emulator's `-ports <console>,<adb>` flag, else its
// `-qmp …/qmp-socket-<console>.sock` path. Matching an actual flag — not a loose
// `qmp-socket-NNNN.sock` substring — keeps a stray path in some other process's argv
// from contributing a phantom port.
function consolePortFromVvdArgs(line: string): number | null {
  const ports = line.match(/(?:^|\s)-ports\s+(\d+),\d+/);
  if (ports) return parseInt(ports[1]!, 10);
  const qmp = line.match(/(?:^|\s)-qmp\s+\S*qmp-socket-(\d+)\.sock/);
  if (qmp) return parseInt(qmp[1]!, 10);
  return null;
}

// Backstop for the local `ps` read against a pathologically-loaded host, not a wedged
// device. Exported so list-devices' BRANCH_DEADLINE_MS accounting can include it: one
// `listVegaDevices()` recovery runs two of these serially (the recovery gate plus the
// `-d emulator-<port>` selector probe).
export const VVD_PS_PROBE_TIMEOUT_MS = 5_000;

/**
 * PIDs of running VVD emulator processes from `ps -o pid=,command=` output. Same VVD
 * identity as `parseVvdConsolePorts`; the stop path kills by pid.
 */
export function parseVvdPids(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2]!;
    // Require an emulator console-port signal (`-ports`/`-qmp`) as well as the binary
    // name: the pid feeds SIGTERM/SIGKILL, so a process that merely mentions a
    // `…/vega-virtual-device` path (e.g. a git command on a branch of that name) must
    // not be mistaken for the device and signalled.
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
    // Don't fail every list-devices / Vega tool call on a `ps` error; log it so a flag
    // incompatibility isn't silently indistinguishable from a genuine "no VVD".
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
