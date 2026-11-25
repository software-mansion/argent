import { afterEach, beforeEach, vi } from "vitest";

/**
 * Runs each test in the calling file on a fake clock that jumps to the next
 * timer whenever the event loop idles: timeouts and poll intervals pass
 * instantly, in real-clock order.
 *
 * Real I/O (a child process, socket or file read) in flight while a timer is
 * pending loses to that timer, so such a test calls `vi.useRealTimers()` first.
 * I/O with no timer pending, like writing a flow file before the run, is safe.
 */
export function useAutoAdvancingClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setTimerTickMode("nextTimerAsync");
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
