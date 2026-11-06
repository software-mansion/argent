import * as fs from "node:fs";
import { pidIsAlive } from "./process-kill";
import { sleep } from "./timing";

export interface FileLockOptions {
  /**
   * A lock whose holder no longer runs, or that its holder has not refreshed
   * for this long, is taken over: a holder that crashed, hangs or is paused,
   * or whose pid another process has by now. The holder refreshes it every
   * third of this time, so a long hold stays valid.
   */
  staleMs: number;
  /** How long to wait for a live holder. */
  timeoutMs: number;
  /** The error after `timeoutMs`, with the holder's pid when the lock names one. */
  timeoutError: (holderPid: number | null) => Error;
}

const POLL_MS = 50;

/**
 * Runs `fn` while this process holds the lock file `lockPath`, which other
 * processes, such as other tool-servers, wait for. Node has no `flock`: the
 * lock is an exclusive create of the file, which names the holder's pid, and
 * the holder removes it at the end.
 */
export async function withFileLock<T>(
  lockPath: string,
  opts: FileLockOptions,
  fn: () => Promise<T> | T
): Promise<T> {
  const fd = await acquireFileLock(lockPath, opts);
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      fs.futimesSync(fd, now, now);
    } catch {
      // Released meanwhile.
    }
  }, opts.staleMs / 3);
  refresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    releaseFileLock(lockPath, fd);
  }
}

async function acquireFileLock(lockPath: string, opts: FileLockOptions): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readHolder(lockPath);
      if (!holder) {
        // Released meanwhile: try again at once.
        if (Date.now() >= deadline) throw opts.timeoutError(null);
        continue;
      }
      const stale =
        (holder.pid !== null && !pidIsAlive(holder.pid)) ||
        Date.now() - holder.mtimeMs > opts.staleMs;
      if (stale) {
        takeOver(lockPath, holder.ino);
        continue;
      }
      if (Date.now() >= deadline) throw opts.timeoutError(holder.pid);
      await sleep(POLL_MS);
      continue;
    }
    try {
      fs.writeSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
    } catch {
      // The pid only speeds up the take-over after a crash; the age covers it.
    }
    return fd;
  }
}

/**
 * The holder's pid, null while it has not written it yet, and the file's
 * identity and age. Null when no lock file is left.
 */
function readHolder(lockPath: string): { pid: number | null; ino: number; mtimeMs: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch {
    return null;
  }
  let pid: number | null = null;
  try {
    const value = (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown }).pid;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) pid = value;
  } catch {
    // Not written yet, or damaged: the age decides.
  }
  return { pid, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

/**
 * Removes the stale lock with inode `ino`. It is moved aside first and checked:
 * when another process took the stale lock over first and holds a new one by
 * now, that new lock is put back.
 */
function takeOver(lockPath: string, ino: number): void {
  const aside = `${lockPath}.${process.pid}.stale`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    // Gone already.
    return;
  }
  try {
    if (fs.lstatSync(aside).ino !== ino) fs.linkSync(aside, lockPath);
  } catch {
    // A third process holds the lock by now.
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Removes the lock file only while it is still this holder's: after a take-over it is another's. */
function releaseFileLock(lockPath: string, fd: number): void {
  try {
    if (fs.lstatSync(lockPath).ino === fs.fstatSync(fd).ino) fs.unlinkSync(lockPath);
  } catch {
    // Taken over and released by another process.
  } finally {
    fs.closeSync(fd);
  }
}
