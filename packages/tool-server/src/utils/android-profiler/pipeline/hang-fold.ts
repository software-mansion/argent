import type { UiHang, UiHangStateBreakdownEntry } from "../../profiler-shared/types";
import type { AndroidHangStateRow, AndroidHangGcRow } from "../types";

/**
 * Fold per-hang state-breakdown rows and GC overlap rows back into the
 * UiHang object. Called once per hang from pipeline/index.ts. Pure: no I/O.
 *
 * State durations are reported in ms (rounded). `blockedFunction` is carried
 * through from the SQL row — non-null only for non-Running states.
 *
 * GC overlap sums the intersection of each `GC: <reason>` slice with the hang
 * window (the SQL already filters slices whose [ts, ts+dur] overlaps the
 * window, but we compute the actual intersection in JS for accuracy).
 */
export function foldHangAnnotations(
  hang: UiHang,
  stateRows: AndroidHangStateRow[],
  gcRows: AndroidHangGcRow[]
): UiHang {
  const stateBreakdown: UiHangStateBreakdownEntry[] = stateRows.map((row) => ({
    state: row.state,
    blockedFunction: row.blocked_function,
    durationMs: Math.round(row.total_dur_ns / 1_000_000),
  }));

  let gcOverlapNs = 0;
  for (const gc of gcRows) {
    const gcStart = gc.ts_ns;
    const gcEnd = gc.ts_ns + gc.dur_ns;
    const overlapStart = Math.max(gcStart, hang.startNs);
    const overlapEnd = Math.min(gcEnd, hang.endNs);
    if (overlapEnd > overlapStart) {
      gcOverlapNs += overlapEnd - overlapStart;
    }
  }

  const next: UiHang = { ...hang };
  if (stateBreakdown.length > 0) {
    next.stateBreakdown = stateBreakdown;
  }
  if (gcOverlapNs > 0) {
    next.gcOverlapMs = Math.round(gcOverlapNs / 1_000_000);
  }
  return next;
}
