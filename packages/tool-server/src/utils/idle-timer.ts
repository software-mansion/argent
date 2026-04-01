/** How often the idle timer checks for inactivity (ms). */
export const IDLE_CHECK_INTERVAL_MS = 60_000;

/** Default idle timeout before auto-shutdown (minutes). */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

export interface IdleTimer {
  touch(): void;
  dispose(): void;
  getLastActivityAt(): number;
}

export function createIdleTimer(
  timeoutMs: number,
  onIdle?: () => void,
): IdleTimer {
  let lastActivityAt = Date.now();
  let interval: ReturnType<typeof setInterval> | null = null;

  if (timeoutMs > 0 && onIdle) {
    const cb = onIdle;
    interval = setInterval(() => {
      if (Date.now() - lastActivityAt >= timeoutMs) {
        process.stderr.write(
          `[argent] No activity for ${Math.round(timeoutMs / 60_000)}min — shutting down\n`,
        );
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
