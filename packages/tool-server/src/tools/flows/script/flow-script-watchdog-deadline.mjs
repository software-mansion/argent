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
// Armed only by the runner's own `workerData`, so other modules can import
// `stopOwnGroup` below without arming it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { workerData } from "node:worker_threads";

const deadlineMs = workerData && workerData.deadlineMs;
if (workerData?.fired instanceof Int32Array && Number.isFinite(deadlineMs) && deadlineMs > 0) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, deadlineMs);
  // Flagged first, so the runner does not report bash's forced exit as its own.
  Atomics.store(workerData.fired, 0, 1);
  // The group, so a descendant the script started goes with it: reaching here
  // means the parent that would have reaped them could not.
  stopOwnGroup();
  process.kill(process.pid, "SIGKILL");
}

/**
 * SIGKILL every other group a descendant sits in, then this process's own. Not in
 * the runner: V8 aborts if the runner exits while a watchdog is still importing it.
 */
export function stopOwnGroup() {
  stopDescendantGroups();
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  // Windows has no groups, so the self-kill would reach this process alone;
  // `taskkill /t` walks the tree instead. Not returning is the wanted outcome.
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
 * Groups the group kill misses (GNU `timeout`, jobs under `set -m`), found through
 * the process tree while this process is alive to lead to them. A descendant with
 * a session of its own is left alone.
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
