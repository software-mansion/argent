import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { pidIsAlive, pollPidsUntilGone, signalGroupThenPid } from "../process-kill";
import { PS_BIN } from "../vega-process";

/**
 * Reap runner xcodebuild processes that outlived the tool-server that launched them.
 */

const execFileAsync = promisify(execFile);

// A busy Mac's full process table with command lines.
const PROCESS_TABLE_MAX_BYTES = 16 * 1024 * 1024;

/** SIGTERM-to-SIGKILL escalation delay. Mirrors killRunnerProcess's 5s. */
const STALE_EXIT_TIMEOUT_MS = 5_000;
const STALE_EXIT_POLL_INTERVAL_MS = 100;

/**
 * Snapshot of `ps -ax -o pid=,ppid=,command=`. `PS_BIN` keeps `ps` findable
 * when the tool-server is GUI-launched.
 */
async function listProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync(PS_BIN, ["-ax", "-o", "pid=,ppid=,command="], {
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });

  return stdout;
}

/**
 * Kill orphaned runner xcodebuild processes for a device. Returns how many were signaled.
 *
 * @param listProcesses test seam. Defaults to the real process table.
 */
export async function killStaleRunnersForDevice(
  udid: string,
  listProcesses: () => Promise<string> = listProcessTable
): Promise<number> {
  let stdout: string;

  try {
    stdout = await listProcesses();
  } catch {
    // A missing process table is not a reason to abort.
    return 0;
  }

  const kill = process.kill.bind(process);
  const signaled: number[] = [];

  for (const line of stdout.split("\n")) {
    // Match only our processes: test-without-building, this UDID, and the cache root.
    if (
      !line.includes("test-without-building") ||
      !line.includes(`platform=iOS,id=${udid}`) ||
      !line.includes(path.join(".argent", "ios-device-runner"))
    ) {
      continue;
    }

    const [pidField, ppidField] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidField ?? "", 10);
    const ppid = Number.parseInt(ppidField ?? "", 10);

    // An unparseable line is spared. When ownership is unknown, not killing is safer.
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === process.pid) {
      continue;
    }

    // A live parent means a peer tool-server owns this runner. Leave it alone.
    if (ppid !== 1 && pidIsAlive(ppid)) {
      continue;
    }

    // SIGTERM did not land. Do not wait on this pid.
    if (!signalGroupThenPid(kill, pid, "SIGTERM")) {
      continue;
    }

    signaled.push(pid);
  }

  // Wait for the signaled pids to exit, then SIGKILL holdouts.
  const remaining = await pollPidsUntilGone(signaled, {
    timeoutMs: STALE_EXIT_TIMEOUT_MS,
    pollIntervalMs: STALE_EXIT_POLL_INTERVAL_MS,
  });

  for (const pid of remaining) {
    // Swallowed failure: the pid exited between the last poll and SIGKILL.
    signalGroupThenPid(kill, pid, "SIGKILL");
  }

  return signaled.length;
}
