import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PS_BIN } from "../vega-process";

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;

/** An `xctrace record` process on this Mac. */
export interface XctraceRecordingProcess {
  pid: number;
  /** How long it has run, as `ps` prints it: `[[dd-]hh:]mm:ss`. */
  elapsed: string;
  command: string;
}

/**
 * The `xctrace record` processes that run on this Mac, of any tool. Empty when
 * `ps` fails: the caller then does not know of one.
 */
export async function runningXctraceRecordings(): Promise<XctraceRecordingProcess[]> {
  try {
    // The executable first, so that a command line that only names xctrace
    // (a grep, a shell) does not count.
    const { stdout: processes } = await execFileAsync(PS_BIN, ["-Axo", "pid=,comm="], {
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const pids = processes
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.*\/)?xctrace\s*$/.exec(line)?.[1])
      .filter((pid): pid is string => pid !== undefined);
    if (pids.length === 0) return [];
    const { stdout } = await execFileAsync(
      PS_BIN,
      ["-o", "pid=,etime=,args=", "-p", pids.join(",")],
      {
        timeout: PS_TIMEOUT_MS,
      }
    );
    const recordings: XctraceRecordingProcess[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
      if (!m || !/(?:^|\/)xctrace record(?:\s|$)/.test(m[3])) continue;
      recordings.push({ pid: Number(m[1]), elapsed: m[2], command: m[3] });
    }
    return recordings;
  } catch {
    return [];
  }
}
