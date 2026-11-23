import * as fs from "node:fs";
import * as path from "node:path";
import { feederGone } from "./ios-audio-rings";

/**
 * Several tool-servers can drive one simulator's audio mock at once (one per argent install or session), and one
 * that is killed (crash, kill -9) never runs `releaseAudio`. Its `input` then makes every app hear silence instead of
 * the microphone. So the host marks what it writes with its pid:
 *
 *   input                      a `host=<pid>` line (the hook reads only the keys it knows)
 *   in-<pid>-*, clip-<pid>-*   the pid in the name
 *
 * and a tool-server that starts using the simulator removes what belongs to a pid that is gone, never what a live
 * process owns. A pid that was reused by another process keeps its files: that errs on the side of leaving them.
 *
 * The apps' own status files (`st.<bundleId>`, with a `pid=<pid>` line) go the same way once their app is gone:
 * the hook never removes them, and a stale one would be read as an app that carries the hook.
 */

/** The line that marks a control file as written by this process. */
export const OWNER_LINE = `host=${process.pid}\n`;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it is only not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function field(text: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
}

/**
 * Whether the `input` control file is abandoned. Without an owner (written by a build before the marker) it is
 * abandoned when its ring is gone, as nothing could then be heard through it, or when an app drained the ring and
 * nobody refilled it (see {@link feederGone}).
 */
async function abandoned(text: string): Promise<boolean> {
  const owner = Number(field(text, "host"));
  if (owner > 0) return !processAlive(owner);
  const ring = field(text, "ring");
  if (!ring || !fs.existsSync(ring)) return true;
  return feederGone(ring);
}

/**
 * Removes what dead tool-servers and dead apps left in the simulator's audio control directory, so apps hear the
 * microphone again. Safe to run while other tool-servers drive the simulator; a missing directory is a no-op.
 */
export async function clearAudioLeftovers(dir: string): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  let liveUnmarkedInput = false;
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  for (const name of names) {
    if (name !== "input") continue;
    const file = path.join(dir, name);
    const text = read(file);
    if (text === null) continue;
    if (!(await abandoned(text))) {
      if (!field(text, "host")) liveUnmarkedInput = true;
      continue;
    }
    // Another tool-server may have replaced the file meanwhile: only remove the one judged.
    if (read(file) !== text) continue;
    fs.rmSync(file, { force: true });
    const ring = field(text, "ring");
    // Only a ring of ours in this directory: the path comes from a file anyone could write.
    if (ring && path.dirname(ring) === dir && /^in-/.test(path.basename(ring))) {
      fs.rmSync(ring, { force: true });
    }
  }
  for (const name of names) {
    if (!name.startsWith("st.")) continue;
    const file = path.join(dir, name);
    const text = read(file);
    if (text === null) continue;
    const pid = Number(field(text, "pid"));
    // Without a pid (a half-written file) it stays; re-read so a relaunched app's fresh status is not removed.
    if (pid > 0 && !processAlive(pid) && read(file) === text) fs.rmSync(file, { force: true });
  }
  for (const name of names) {
    const owner = /^(?:in|clip)-(\d+)-/.exec(name);
    // Unmarked rings and clips belong to an unmarked input: they go once no live one is left.
    const unmarked = !owner && /^(?:in|clip)-/.test(name) && !liveUnmarkedInput;
    if ((owner && !processAlive(Number(owner[1]))) || unmarked) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}
