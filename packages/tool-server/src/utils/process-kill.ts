/**
 * Shared SIGTERM-to-SIGKILL escalation primitives for detached child process
 * groups. Two stacks terminate detached children this way: the physical-iOS
 * runner (utils/ios-device/runner-launch.ts and runner-sweep.ts) and runner-booted Chromium/Electron
 * apps (tools/devices/boot-electron.ts). Both spawn detached, so pgid=pid names
 * the child's own group, and descendants that survive a leader-only signal stay
 * reachable: they reparent to init but keep their pgid.
 *
 * Only the genuinely identical pieces live here. Each side keeps its own
 * timing constants (5s grace / 100ms poll for the runner, 2s grace / 50ms poll
 * for Chromium), its own sleep helper (the runner's holds the event loop, the
 * Chromium one is unref'd), and boot-electron keeps its wall-clock exit poll
 * and its single-timer handle escalation; see the call sites for why.
 */

/**
 * Signal the whole process group led by `pid`, reporting whether anything was
 * there. With signal 0 this doubles as a group liveness probe. Never falls
 * back to the bare pid: the leader routinely exits while helpers live on, so
 * for these callers the group is the only truthful target.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    // ESRCH = the group is empty; anything else (EPERM) means it isn't.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Signal 0 probes liveness without delivering anything. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Group signal with a bare-pid fallback: kill(-pid), and only when that fails
 * kill(pid). Returns whether either delivery succeeded, so a caller can skip
 * waiting on a pid nothing reached; both failures are swallowed (the process
 * exited before the signal, which is the desired outcome). `kill` is a
 * parameter, not process.kill, because the runner sweep (runner-sweep.ts)
 * routes its signals through an injectable test seam.
 */
export function signalGroupThenPid(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals
): boolean {
  try {
    kill(-pid, signal);
    return true;
  } catch {
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Arm a delayed, unref'd group SIGKILL for processes stuck in shutdown after a
 * graceful signal. `gateOnGroupLiveness: true` re-probes the group at fire
 * time and skips the SIGKILL once it has emptied, so a raw pid recorded before
 * the grace period cannot SIGKILL a recycled pgid (boot-electron's fallback
 * path); `false` fires unconditionally, the runner path's historical contract.
 * Either way delivery errors are swallowed: the group emptying first is
 * success.
 */
export function scheduleGroupSigkill(
  pid: number,
  graceMs: number,
  opts: { gateOnGroupLiveness: boolean }
): void {
  setTimeout(() => {
    if (opts.gateOnGroupLiveness && !signalGroup(pid, 0)) return;
    signalGroup(pid, "SIGKILL");
  }, graceMs).unref();
}

/**
 * Bounded liveness poll over already-signaled pids: probe on entry (pids dead
 * from the start cost nothing), then sleep/re-probe up to
 * ceil(timeoutMs/pollIntervalMs) times, returning the pids still alive when
 * the window closes. The window is counted in sleeps of the injectable `sleep`
 * rather than wall-clock time, so tests drive it deterministically without
 * timers; boot-electron's handle-less exit wait deliberately keeps its own
 * wall-clock loop instead (a real deadline over unref'd sleeps).
 */
export async function pollPidsUntilGone(
  pids: readonly number[],
  opts: {
    timeoutMs: number;
    pollIntervalMs: number;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<number[]> {
  const isAlive = opts.isAlive ?? pidIsAlive;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const maxPolls = Math.max(1, Math.ceil(opts.timeoutMs / opts.pollIntervalMs));
  let remaining = pids.filter((pid) => isAlive(pid));
  for (let poll = 0; poll < maxPolls && remaining.length > 0; poll += 1) {
    await sleep(opts.pollIntervalMs);
    remaining = remaining.filter((pid) => isAlive(pid));
  }
  return remaining;
}
