// Reads fd 4, the extra pipe the executor opens when it forks this process.
// Nothing is ever written to it; the parent holds the other end, and that end
// closing is how a runner learns the tool server is gone. This thread then
// stops the whole process.
//
// None of the softer controls reach a runner whose parent died: a tool-server
// process-group stop does not reach a detached runner, and the runner's
// `disconnect` handler is a main-thread event-loop callback that a synchronous
// infinite loop never yields to. A worker thread has its own event loop on its
// own OS thread, so a spinning main thread cannot starve it.
//
// It reads through the event loop, not `fs.readSync`: a thread parked inside a
// synchronous syscall cannot be joined, and Node joins its worker threads
// before leaving — so with a blocking read every exit path hangs until the
// parent's time limit, including a passing script's own exit.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { workerData } from "node:worker_threads";

const LIFELINE_FD = 4;

/**
 * How often the pid below is checked. Loose on purpose: it is the second
 * reading, for a descriptor that is gone, and the end of file is what answers
 * in the ordinary case within a millisecond.
 */
const PARENT_POLL_MS = 1_000;

const stop = () => {
  // The *group*, not just this process: the tool server is already gone, so its
  // cleanup will never run and every descendant the script started would be
  // left behind. Killing the group takes this process with it, which is the
  // point — the main thread it has to stop may be in the very synchronous loop
  // this control exists for.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  // Windows has no group for the line above to name, so the self-kill below
  // used to be the whole reach — leaving bash, and a `.mjs` script's own
  // subprocesses, running under a tool server that had died. `taskkill /t`
  // walks the live tree from this process down instead. `child_process` is
  // available in a worker thread, and this call not returning is the outcome
  // wanted; `taskkill.exe` is itself a descendant of the pid it is aimed at.
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // taskkill is absent or could not be launched; the self-kill is what is left.
    }
  }
  process.kill(process.pid, "SIGKILL");
};

try {
  const lifeline = new net.Socket({ fd: LIFELINE_FD, readable: true, writable: false });
  // End of file reaches a socket as `end`, `close` or a broken-pipe `error`
  // depending on the platform; all three mean the parent is gone.
  lifeline.on("end", stop);
  lifeline.on("close", stop);
  lifeline.on("error", stop);
  // The parent never writes, but a paused stream would never reach its own end
  // event.
  lifeline.resume();
} catch (err) {
  // Reporting must never be what ends this thread. The descriptor is missing
  // in the first place because the parent is gone or the script took it away,
  // and either way stderr may be a pipe with no reader left, whose write throws
  // `EPIPE` — at module scope, so the thread would die with the watchdog below
  // unarmed, exactly when it is the only one left.
  try {
    fs.writeSync(2, `[argent] script lifeline unavailable: ${err && err.message}\n`);
  } catch {
    // Nothing is listening; the note is not worth the watchdog.
  }
}

// The same news read a second way, because a descriptor is a number script code
// can name: `fs.closeSync(4)`, or a helper that closes everything above stderr.
// Closed before this armed, the socket above could not be built; closed after,
// the kernel drops the descriptor from the poller and no end of file ever
// fires. Either way the run finished with the group kill never armed, and
// descendants outlived a tool server that died afterwards.
//
// The parent's number, which nothing in this process can take away. POSIX
// re-parents an orphan the moment its parent dies, so a changed `ppid` is the
// same news the end of file carries — and it is news at the death rather than
// at the reaping, unlike asking whether the pid can still be signalled, which a
// parent nobody has waited on answers yes to. The read is live inside a worker
// thread. Windows keeps the original number, so there the descriptor is all
// there is.
//
// The runner reads the pid before any script code runs, so it is the real
// parent's. A parent that is already pid 1 is not watched: an orphan re-parents
// to pid 1, so the comparison could never come out true.
const parentPid = workerData && workerData.parentPid;
if (process.platform !== "win32" && Number.isInteger(parentPid) && parentPid > 1) {
  // Deliberately not unref'd: it is what keeps this thread alive once the
  // socket is gone, and the runner unrefs the whole worker, so it never holds
  // the process open by itself.
  setInterval(() => {
    if (process.ppid !== parentPid) stop();
  }, PARENT_POLL_MS);
}
