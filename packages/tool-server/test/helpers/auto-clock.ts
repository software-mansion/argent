import { afterEach, beforeEach, vi } from "vitest";

/**
 * Runs each test in the calling file on a fake clock that jumps to the next
 * timer whenever the event loop idles: timeouts and poll intervals pass
 * instantly, in real-clock order.
 *
 * Only for in-memory work. Real I/O (a child process, socket or file read) in
 * flight when the clock jumps loses to the timer, so such a test calls
 * `vi.useRealTimers()` first.
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
