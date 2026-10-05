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
//
// Armed only by the runner's own `workerData`, so the runner and the lifeline
// can import `stopOwnGroup` below, and so can the inactive runner a `.mjs`
// script's own worker threads inherit.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { workerData } from "node:worker_threads";

const deadlineMs = workerData && workerData.deadlineMs;
if (workerData?.fired instanceof Int32Array && Number.isFinite(deadlineMs) && deadlineMs > 0) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, deadlineMs);
  // Before anything is stopped, so the runner's own thread cannot report what
  // the stop does to bash as the script's own answer: `taskkill /t` takes the
  // tree one process at a time.
  Atomics.store(workerData.fired, 0, 1);
  // The group, so a descendant the script started goes with it: reaching here
  // means the parent that would have reaped them could not.
  stopOwnGroup();
  process.kill(process.pid, "SIGKILL");
}

/**
 * SIGKILL this process's group, and before it every other group a descendant
 * of this process sits in. Here rather than in the runner: a watchdog that
 * imports the runner is still loading it when a fast script's runner exits,
 * and V8 then aborts the process with a fatal error on stderr.
 */
export function stopOwnGroup() {
  stopDescendantGroups();
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  // Windows has no group for the line above to name, so a self-kill reaches
  // this process alone, leaving bash — and a `.mjs` script's own subprocesses
  // — running. `taskkill /t` walks the live tree from this process down
  // instead. `child_process` is available in a worker thread, and this call
  // not returning is the outcome wanted; `taskkill.exe` is itself a descendant
  // of the pid it is aimed at.
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
}

/**
 * GNU `timeout` moves itself and its command into a group of their own, and so
 * does every job under `set -m`, so the group kill misses them. They are found
 * through the process tree, which leads to them only while this process is
 * alive, so this runs before the group kill. A descendant that started a
 * session of its own - `setsid`, a daemon such as the adb server, Node's
 * `detached` - is left alone with all below it. Windows has no groups, and
 * `taskkill /t` walks the tree itself.
 */
function stopDescendantGroups() {
  if (process.platform === "win32") return;
  let table;
  try {
    const ps = ["/bin/ps", "/usr/bin/ps"].find((file) => fs.existsSync(file)) ?? "ps";
    table = spawnSync(ps, ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
    }).stdout;
  } catch {
    return;
  }
  const children = new Map();
  const groupOf = new Map();
  const sessionLeaders = new Set();
  for (const line of (table ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
    groupOf.set(pid, pgid);
    if (match[4].includes("s")) sessionLeaders.add(pid);
    if (children.has(ppid)) children.get(ppid).push(pid);
    else children.set(ppid, [pid]);
  }
  const groups = new Set();
  const pending = [process.pid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()) ?? []) {
      if (seen.has(child) || sessionLeaders.has(child)) continue;
      seen.add(child);
      pending.push(child);
      groups.add(groupOf.get(child));
    }
  }
  groups.delete(process.pid);
  for (const group of groups) {
    if (group <= 1) continue;
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}
