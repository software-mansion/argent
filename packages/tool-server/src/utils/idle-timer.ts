/** How often the idle timer checks for inactivity (ms). */
export const IDLE_CHECK_INTERVAL_MS = 60_000;

/** Default idle timeout before auto-shutdown (minutes). */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

export interface IdleTimer {
  touch(): void;
  /** Mark a request as in flight; returns a release fn to call on completion. */
  beginRequest(): () => void;
  dispose(): void;
  getLastActivityAt(): number;
}

export function createIdleTimer(timeoutMs: number, onIdle?: () => void): IdleTimer {
  let lastActivityAt = Date.now();
  let inFlight = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  if (timeoutMs > 0 && onIdle) {
    const cb = onIdle;
    interval = setInterval(() => {
      // A long-running tool call (e.g. xctrace export, RN build) can
      // outlive the idle window. Treat any in-flight request as activity
      // so the periodic check can never shut us down mid-response.
      if (inFlight > 0) {
        lastActivityAt = Date.now();
        return;
      }
      if (Date.now() - lastActivityAt >= timeoutMs) {
        process.stderr.write(
          `[argent] No activity for ${Math.round(timeoutMs / 60_000)}min — shutting down\n`
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
    beginRequest() {
      inFlight++;
      lastActivityAt = Date.now();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight = Math.max(0, inFlight - 1);
        lastActivityAt = Date.now();
      };
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
