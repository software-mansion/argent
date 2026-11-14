/**
 * The Allocations instrument of the Argent template loads a recorder into the app,
 * which runs inside each allocation of the app, also on the main thread. A hang can be
 * mostly that recorder's work. Measured on Food Truck for macOS, the same walk over 8 screens:
 * 7 hangs with the default template, where the recorder was 23 to 298 ms of the main
 * thread in each, and 3 of them had under 250 ms without it; 1 hang with Time Profiler.
 */
import type { CpuSample, RawHang } from "./types";
import { toolingWork } from "./pipeline/02-aggregate";
import { normalizeThreadName } from "../profiler-shared/thread";

/** What taking the recorder's main-thread time out of the hangs changed. */
export interface RecorderAdjustment {
  /** Hangs left out: under 250 ms of each was not the recorder (nor a suspension). */
  removedHangs: number;
  /** Hangs kept with the recorder's time taken out of their length. */
  adjustedHangs: number;
  /** The recorder's main-thread CPU time in all the hangs above, in ms. */
  recorderMs: number;
}

/**
 * The recorder's main-thread CPU time in each hang's span, from the CPU samples.
 * removeSuspendedTime (app-suspensions.ts) takes it out of the hangs, after the
 * app's suspensions.
 */
export function recorderNsIn(hangs: readonly RawHang[], samples: readonly CpuSample[]): number[] {
  const recorder = samples
    .filter(
      (s) =>
        normalizeThreadName(s.threadFmt) === "Main Thread" && toolingWork(s.stack) === "instruments"
    )
    .sort((a, b) => a.timestampNs - b.timestampNs);
  return hangs.map((hang) => {
    const end = hang.startNs + hang.durationNs;
    let total = 0;
    for (const s of recorder) {
      if (s.timestampNs > end) break;
      if (s.timestampNs >= hang.startNs) total += s.weightNs;
    }
    return total;
  });
}
