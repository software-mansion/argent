import type { UiHang, UiHangStateBreakdownEntry } from "../../profiler-shared/types";
import type { AndroidHangStateRow, AndroidHangGcRow } from "../types";

/**
 * Fold per-hang state-breakdown and GC rows into a copy of the UiHang.
 *
 * The SQL only selects GC slices that overlap the hang window; the actual
 * intersection is clipped here, so `gcRows` must already be trace-relative.
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
