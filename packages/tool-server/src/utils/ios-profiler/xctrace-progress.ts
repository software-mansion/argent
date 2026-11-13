import { execFile, type ChildProcess } from "child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { PS_BIN } from "../vega-process";

const execFileAsync = promisify(execFile);

/**
 * A fingerprint of a stopping xctrace's progress for `shutdownChild`'s stall
 * watch: its CPU time and the bytes in the trace bundle. Null when the child
 * has no pid; rejects when `ps` or the bundle cannot be read, which the watch
 * treats as no reading.
 */
export function xctraceProgressProbe(
  child: ChildProcess,
  traceFile: string
): () => Promise<string | null> {
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
    return `${stdout.trim()}|${bytes}`;
  };
}
