export const IDLE_CHECK_INTERVAL_MS = 60_000;

interface IdleTimer {
  touch(): void;
  dispose(): void;
  getLastActivityAt(): number;
}

/**
 * Shorter idle limit that applies only once the process that spawned this
 * server is gone. A live MCP client pings every 30s, so a server whose spawner
 * exited and that nobody has used for this long has no clients left.
 */
export interface OrphanIdleOptions {
  timeoutMs: number;
  isOrphaned: () => boolean;
}

export function createIdleTimer(
  timeoutMs: number,
  onIdle?: () => void,
  orphan?: OrphanIdleOptions
): IdleTimer {
  let lastActivityAt = Date.now();
  let interval: ReturnType<typeof setInterval> | null = null;
  const orphanTimeoutMs = orphan && orphan.timeoutMs > 0 ? orphan.timeoutMs : 0;

  if ((timeoutMs > 0 || orphanTimeoutMs > 0) && onIdle) {
    const cb = onIdle;
    interval = setInterval(() => {
      const idleFor = Date.now() - lastActivityAt;
      let reason: string | null = null;
      if (timeoutMs > 0 && idleFor >= timeoutMs) {
        reason = `No activity for ${Math.round(timeoutMs / 60_000)}min`;
      } else if (orphanTimeoutMs > 0 && idleFor >= orphanTimeoutMs && orphan!.isOrphaned()) {
        reason = `Spawning process exited and no activity for ${Math.round(orphanTimeoutMs / 60_000)}min`;
      }
      if (reason) {
        process.stderr.write(`[argent] ${reason} — shutting down\n`);
        cb();
      }
    }, IDLE_CHECK_INTERVAL_MS);
    interval.unref();
  }

  return {
    touch() {
      lastActivityAt = Date.now();
    },
    dispose() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
    getLastActivityAt() {
      return lastActivityAt;
    },
  };
}

/** True when `pid` no longer names a live process (signal 0 probe). */
export function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else (reused) — not ours,
    // yet not provably gone either; treat as alive to stay conservative.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
