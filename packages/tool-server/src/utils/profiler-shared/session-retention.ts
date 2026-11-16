import { promises as fs } from "fs";
import * as path from "path";
import { scanProfilerSessions } from "./session-ids";

/**
 * How long a saved profiling session stays after its last use. macOS empties the
 * files of the temporary directory that no one has read for about 3 days (it
 * leaves the folders), so an older session is mostly gone already.
 */
export const SESSION_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** The one React report file that every session wrote before each got its own. */
const LEGACY_ENTRIES = ["react-profiler-report.md"];

/**
 * Deletes the sessions in the profiler folder that no tool used for
 * SESSION_RETENTION_MS: no write to any of its files (a start, a stop, an
 * analyze, a load) is newer. A session that records, exports or was loaded
 * within that time stays. Other files stay. Returns the names it deleted.
 */
export async function deleteOldProfilerSessions(
  dir: string,
  now: number = Date.now()
): Promise<string[]> {
  const sessions = await scanProfilerSessions(dir);
  if (!sessions) return [];
  const groups = [...sessions.native.values(), ...sessions.react.values()];
  for (const name of LEGACY_ENTRIES) {
    const exists = await fs.lstat(path.join(dir, name)).then(
      () => true,
      () => false
    );
    if (exists) groups.push([name]);
  }

  const old = async (names: string[]): Promise<boolean> => {
    let lastUse = 0;
    for (const name of names) {
      try {
        lastUse = Math.max(lastUse, (await fs.lstat(path.join(dir, name))).mtimeMs);
      } catch {
        // gone already
      }
    }
    return now - lastUse > SESSION_RETENTION_MS;
  };

  const deleted: string[] = [];
  const remove = async (names: string[]) => {
    for (const name of names) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      deleted.push(name);
    }
  };
  for (const names of groups) {
    if (await old(names)) await remove(names);
  }
  return deleted;
}

/**
 * Runs deleteOldProfilerSessions without holding up the caller. Called where a
 * new session starts to fill the folder; a failure only leaves old files.
 */
export function startOldProfilerSessionCleanup(dir: string): void {
  deleteOldProfilerSessions(dir).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[profiler] could not delete old sessions in ${dir}: ${msg}\n`);
  });
}

/**
 * Marks a session as used now, so the cleanup keeps it for SESSION_RETENTION_MS
 * more. Files that do not exist are skipped.
 */
export async function markProfilerSessionUsed(files: readonly string[]): Promise<void> {
  const now = new Date();
  await Promise.all(files.map((file) => fs.utimes(file, now, now).catch(() => undefined)));
}
