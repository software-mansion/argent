import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Console ports of all running VVDs (empty if none / `ps` unavailable). `>1` ⇒
 * multiple VVDs — callers that target one surface `MultipleVegaDevicesError`.
 */
export async function listRunningVvdConsolePorts(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync("ps", [...PS_ARGS], {
      timeout: 5_000,
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
