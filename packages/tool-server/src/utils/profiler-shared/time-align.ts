/**
 * Cross-tool time alignment utilities.
 *
 * React Profiler uses performance.now() milliseconds with a monotonic origin.
 * iOS Instruments uses trace-relative nanoseconds from xctrace.
 * Both tools record Date.now() (wall clock) at start time, providing a shared anchor.
 *
 * Wall clock is imprecise (~15ms jitter) but sufficient for correlating events
 * at the 100ms+ granularity where hangs and slow commits overlap.
 */

export interface TimeAnchor {
  wallClockMs: number;
  monotonicStartMs: number;
}

/**
 * Convert a React profiler timestamp (performance.now ms) to wall clock ms.
 */
export function reactTimeToWallClock(
  reactMs: number,
  reactAnchor: TimeAnchor,
): number {
  const elapsed = reactMs - reactAnchor.monotonicStartMs;
  return reactAnchor.wallClockMs + elapsed;
}

/**
 * Convert a wall clock ms to iOS Instruments trace-relative nanoseconds.
 */
export function wallClockToInstrumentsNs(
  wallMs: number,
  iosAnchor: TimeAnchor,
): number {
  const elapsed = wallMs - iosAnchor.wallClockMs;
  return (iosAnchor.monotonicStartMs + elapsed) * 1_000_000;
}

/**
 * Convert a React profiler timestamp directly to iOS Instruments nanoseconds.
 */
export function reactTimeToInstrumentsNs(
  reactMs: number,
  reactAnchor: TimeAnchor,
  iosAnchor: TimeAnchor,
): number {
  const wallMs = reactTimeToWallClock(reactMs, reactAnchor);
  return wallClockToInstrumentsNs(wallMs, iosAnchor);
}

/**
 * Convert iOS Instruments nanoseconds to wall clock ms.
 */
export function instrumentsNsToWallClock(
  instrumentsNs: number,
  iosAnchor: TimeAnchor,
): number {
  const elapsedMs = instrumentsNs / 1_000_000 - iosAnchor.monotonicStartMs;
  return iosAnchor.wallClockMs + elapsedMs;
}

/**
 * Check if two time windows overlap, with an optional tolerance in ms.
 */
export function windowsOverlap(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number,
  toleranceMs: number = 0,
): boolean {
  return aStartMs - toleranceMs <= bEndMs && aEndMs + toleranceMs >= bStartMs;
}

/**
 * Build a TimeAnchor for the React profiler from session data.
 * monotonicStartMs is the first commit timestamp or the CPU profile start time.
 */
export function buildReactAnchor(
  wallClockStartMs: number,
  cpuProfileStartTimeUs: number,
): TimeAnchor {
  return {
    wallClockMs: wallClockStartMs,
    monotonicStartMs: cpuProfileStartTimeUs / 1000,
  };
}

/**
 * Build a TimeAnchor for iOS Instruments.
 * monotonicStartMs is 0 since xctrace timestamps are trace-relative (start at 0).
 */
export function buildIosAnchor(wallClockStartMs: number): TimeAnchor {
  return {
    wallClockMs: wallClockStartMs,
    monotonicStartMs: 0,
  };
}
