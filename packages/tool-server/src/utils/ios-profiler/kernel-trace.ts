import { execFileSync } from "child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * For each recording, xctrace's helper process (DTServiceHub, which launchd
 * starts for each xctrace) writes the raw kernel trace to
 * `instruments<random>.ktrace` in the user's temporary folder. Nothing deletes
 * it: 150 MB to more than 1 GB for each recording, also for one that xctrace
 * ended on its time limit. The helper can keep it open for minutes after
 * xctrace exited.
 */
const KERNEL_TRACE_NAME = /^instruments.*\.ktrace$/;

let tempDir: string | undefined;

/**
 * The folder of the helper, which launchd starts: not the TMPDIR of this process.
 * After a failed `getconf` (a timeout on a busy Mac), this process's own temporary
 * folder, and the next call asks `getconf` again.
 */
export function kernelTraceDir(): string {
  if (tempDir) return tempDir;
  try {
    tempDir =
      execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim() || undefined;
  } catch {
    // Asked again at the next call.
  }
  return tempDir ?? os.tmpdir();
}

/** The names of the kernel trace files in `dir`; empty when it cannot be read. */
export async function listKernelTraces(dir: string): Promise<Set<string>> {
  try {
    return new Set((await fsp.readdir(dir)).filter((name) => KERNEL_TRACE_NAME.test(name)));
  } catch {
    return new Set();
  }
}

/**
 * The one kernel trace file that is in `dir` now and was not in `before`, or
 * null. Two or more new files mean that another recording started at the same
 * time, and nothing tells which file is whose.
 */
export async function newKernelTrace(dir: string, before: Set<string>): Promise<string | null> {
  const added = [...(await listKernelTraces(dir))].filter((name) => !before.has(name));
  return added.length === 1 ? path.join(dir, added[0]) : null;
}

const SETTLE_POLL_MS = 2_000;
const SETTLE_LIMIT_MS = 60_000;

/**
 * Deletes the kernel trace of a recording whose xctrace exited, once nothing
 * writes to it and `ours()` still says that it is that recording's: a helper
 * whose xctrace was killed goes on for a few seconds, and a file that keeps
 * growing belongs to a recording that still runs, so it stays. Empties the file
 * first: a helper that still holds it open would keep its blocks on disk until
 * it exits, which can take more than 15 minutes.
 */
export function removeKernelTraceWhenIdle(file: string, ours: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let last = -1;
    const deadline = Date.now() + SETTLE_LIMIT_MS;
    const check = async () => {
      let size: number;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        return resolve();
      }
      if (size !== last && Date.now() < deadline) {
        last = size;
        setTimeout(() => void check(), SETTLE_POLL_MS).unref();
        return;
      }
      if (size === last && ours()) {
        try {
          await fsp.truncate(file, 0);
          await fsp.rm(file, { force: true });
        } catch {
          // Gone already, or not ours to delete.
        }
      }
      resolve();
    };
    void check();
  });
}
