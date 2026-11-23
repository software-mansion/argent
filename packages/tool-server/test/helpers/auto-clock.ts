import { afterEach, beforeEach, vi } from "vitest";

/**
 * Runs every test in the calling file on a fake clock that jumps to the next
 * timer whenever the event loop goes idle, so timeouts, settle windows and poll
 * intervals pass instantly and in the same order as on the real clock.
 *
 * Only for files whose awaited work is all in memory. A real child process,
 * socket or file read in flight when the clock jumps loses the race to the
 * timer, so such a test calls `vi.useRealTimers()` first.
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
