// The step's time limit applied inside the child, so an orphan has a bounded
// life even on a host where the lifeline does not fire: `Atomics.wait` behaves
// identically everywhere, while the lifeline's end-of-file reporting differs by
// platform. It blocks the thread outright — no event loop, no timer, no CPU —
// so it costs nothing while the script runs.
//
// The deadline the parent sends is deliberately its own limit plus a margin, so
// that this stays the second line and not the first: a parent that reports
// "timed out and was stopped" says more than a child that kills its own group
// and leaves the parent describing an unexplained SIGKILL.

import { spawnSync } from "node:child_process";
import { workerData } from "node:worker_threads";

const deadlineMs = workerData && workerData.deadlineMs;
if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, deadlineMs);
  // The group, so a descendant the script started goes with it: reaching here
  // means the parent that would have reaped them could not.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  // Windows has no group for the line above to name, so the self-kill below
  // used to be the whole reach — leaving bash, and a `.mjs` script's own
  // subprocesses, running. `taskkill /t` walks the live tree from this process
  // down instead. `child_process` is available in a worker thread, and this
  // call not returning is the outcome wanted; `taskkill.exe` is itself a
  // descendant of the pid it is aimed at.
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
}
