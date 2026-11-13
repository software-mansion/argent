import { execFile, type ChildProcess } from "child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { PS_BIN } from "../vega-process";

const execFileAsync = promisify(execFile);

/**
 * The share of one CPU core that xctrace must use over the stall watch's idle
 * limit for its CPU time to count as progress, until it says that it stops. An
 * xctrace that did not take the SIGINT and records on uses 0.24 to 0.5 % of a
 * core with an idle app, so its CPU time changes every few seconds: such stops
 * waited until they were killed. After xctrace says that it stops, any CPU time
 * counts: a healthy stop first waits up to 23 s at 0.24 % of a core.
 */
const MIN_CPU_SHARE = 0.01;

interface ProbeOptions {
  /** The stall watch's idle limit. */
  idleMs: number;
  /** True once xctrace has said that it stops the recording. */
  stopping: () => boolean;
}

/**
 * A fingerprint of a stopping xctrace's progress for `shutdownChild`'s stall
 * watch: its CPU time and the bytes in the trace bundle. Until xctrace says
 * that it stops, the CPU time changes the fingerprint only when it grew by
 * {@link MIN_CPU_SHARE} of `idleMs` since the last change. Null when the child
 * has no pid; rejects when `ps` or the bundle cannot be read, which the watch
 * treats as no reading.
 */
export function xctraceProgressProbe(
  child: ChildProcess,
  traceFile: string,
  { idleMs, stopping }: ProbeOptions
): () => Promise<string | null> {
  const minCpuS = (MIN_CPU_SHARE * idleMs) / 1000;
  let counted: { cpu: string; seconds: number; bytes: number } | null = null;
  return async () => {
    if (!child.pid) return null;
    const { stdout } = await execFileAsync(PS_BIN, ["-o", "time=", "-p", String(child.pid)], {
      timeout: 2_000,
    });
    const entries = await fsp.readdir(traceFile, { recursive: true, withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      bytes += (await fsp.stat(path.join(entry.parentPath, entry.name))).size;
    }
    const cpu = stdout.trim();
    const seconds = cpuSeconds(cpu);
    if (
      counted === null ||
      bytes !== counted.bytes ||
      Number.isNaN(seconds) ||
      Number.isNaN(counted.seconds) ||
      seconds - counted.seconds >= (stopping() ? 0 : minCpuS)
    ) {
      counted = { cpu, seconds, bytes };
    }
    return `${counted.cpu}|${counted.bytes}`;
  };
}

/** `ps -o time=` in seconds, from `[[dd-]hh:]mm:ss[.cc]`; NaN for anything else. */
function cpuSeconds(time: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time);
  if (!match) return Number.NaN;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}
