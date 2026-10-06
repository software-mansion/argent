/**
 * React Profiler timestamps are performance.now() ms; native traces (xctrace,
 * perfetto) are trace-relative ns. The only value both record in a common clock
 * is Date.now() at start, so all conversions go through that wall-clock anchor.
 */

export interface TimeAnchor {
  wallClockMs: number;
  monotonicStartMs: number;
}

export function reactTimeToWallClock(reactMs: number, reactAnchor: TimeAnchor): number {
  const elapsed = reactMs - reactAnchor.monotonicStartMs;
  return reactAnchor.wallClockMs + elapsed;
}

export function instrumentsNsToWallClock(instrumentsNs: number, iosAnchor: TimeAnchor): number {
  const elapsedMs = instrumentsNs / 1_000_000 - iosAnchor.monotonicStartMs;
  return iosAnchor.wallClockMs + elapsedMs;
}

export function windowsOverlap(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number,
  toleranceMs: number = 0
): boolean {
  return aStartMs - toleranceMs <= bEndMs && aEndMs + toleranceMs >= bStartMs;
}

export function buildReactAnchor(
  wallClockStartMs: number,
  cpuProfileStartTimeUs: number
): TimeAnchor {
  return {
    wallClockMs: wallClockStartMs,
    monotonicStartMs: cpuProfileStartTimeUs / 1000,
  };
}

/** monotonicStartMs is 0 because xctrace timestamps are trace-relative. */
export function buildIosAnchor(wallClockStartMs: number): TimeAnchor {
  return {
    wallClockMs: wallClockStartMs,
    monotonicStartMs: 0,
  };
}

/**
 * Same shape as buildIosAnchor (perfetto ts are normalised to trace-relative),
 * kept separate so the platform branches read symmetrically.
 */
export function buildPerfettoAnchor(wallClockStartMs: number): TimeAnchor {
  return {
    wallClockMs: wallClockStartMs,
    monotonicStartMs: 0,
  };
}
