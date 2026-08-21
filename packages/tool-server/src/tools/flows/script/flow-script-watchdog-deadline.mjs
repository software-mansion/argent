// Watchdog B — the deadline.
//
// The child's own copy of the step's time limit. It applies even when the
// parent is gone, which is what makes it the platform-neutral backstop:
// `Atomics.wait` behaves identically everywhere, while the lifeline's
// end-of-file reporting differs by platform. An orphan therefore has a bounded
// life even on a host where the lifeline does not fire.
//
// `Atomics.wait` blocks the thread outright — no event loop, no timer, no CPU —
// so this costs nothing while the script runs. The deadline the parent sends is
// deliberately its own limit plus a margin, so that this stays the second line
// and not the first: a parent that reports "timed out and was stopped" says
// more than a child that kills its own group and leaves the parent describing
// an unexplained SIGKILL.

import { workerData } from "node:worker_threads";

const deadlineMs = workerData && workerData.deadlineMs;
if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, deadlineMs);
  // The group, so a descendant the script started goes with it — see the same
  // reasoning in the lifeline watchdog. An orphan's descendants have no other
  // control: the parent that would have reaped them is gone.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  process.kill(process.pid, "SIGKILL");
}
