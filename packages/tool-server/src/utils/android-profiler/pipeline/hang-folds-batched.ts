import { runTpInline } from "./run-tp";
import type { AndroidHangStateRow, AndroidHangGcRow } from "../types";

/**
 * Per-hang annotation data, indexed by the caller-assigned hang index.
 * Hangs with no thread_state rows in their window get an empty `state`
 * array; hangs with no GC overlap get an empty `gc` array.
 */
export interface HangFoldsBatched {
  state: Map<number, AndroidHangStateRow[]>;
  gc: Map<number, AndroidHangGcRow[]>;
}

export interface HangWindowInput {
  /** Caller's stable index. Returned untouched in the output maps. */
  hangIndex: number;
  /** Hang start in NATIVE (CLOCK_MONOTONIC) ns — not trace-relative. */
  startNs: number;
  /** Hang end in NATIVE (CLOCK_MONOTONIC) ns — not trace-relative. */
  endNs: number;
}

export interface RunBatchedHangFoldsOptions {
  tracePath: string;
  /** Sanitised process / package name. Caller validates the alphabet. */
  target: string;
  hangs: HangWindowInput[];
}

/**
 * Compute main-thread state breakdown + GC overlap for ALL hang windows in
 * a single trace_processor_shell invocation.
 *
 * Replaces the legacy per-hang `runTpQuery` loop, which paid the
 * trace_processor_shell trace-load cost (~1.3 s) on every iteration. With
 * 1013 hangs × 2 queries that was ~47 minutes serial; this collapses it to
 * a single invocation, ~1.7 s end-to-end on a 76 MB trace regardless of
 * hang count (the per-hang work moves into a JOIN over a runtime-built
 * `argent_hang_windows` table).
 *
 * Schema invariants:
 *   • Each hang's `startNs`/`endNs` must be a finite non-negative integer.
 *     The values are inlined into SQL as bare digits — not quoted — so any
 *     non-numeric input would produce a SQL syntax error rather than an
 *     injection. We assert this for defence-in-depth.
 *   • `target` must already have been validated against the package-name
 *     alphabet by the caller. It's wrapped in single quotes with literal
 *     `'` characters disallowed.
 *
 * Failure semantics: a single rejected promise. The pipeline treats this
 * the same way it treats any per-stage failure — every hang gets empty
 * state/gc folds and the error message lands in `exportErrors`.
 */
export async function runBatchedHangFolds(
  opts: RunBatchedHangFoldsOptions
): Promise<HangFoldsBatched> {
  const empty: HangFoldsBatched = { state: new Map(), gc: new Map() };
  if (opts.hangs.length === 0) return empty;

  validateTarget(opts.target);
  const valuesTuples: string[] = [];
  for (const hang of opts.hangs) {
    assertSafeWindow(hang);
    valuesTuples.push(`(${hang.hangIndex},${hang.startNs},${hang.endNs})`);
  }

  const sql = `
DROP TABLE IF EXISTS argent_hang_windows;
CREATE PERFETTO TABLE argent_hang_windows AS
SELECT
  column1 AS hang_index,
  column2 AS start_ns,
  column3 AS end_ns
FROM (VALUES
  ${valuesTuples.join(",\n  ")}
);

DROP VIEW IF EXISTS argent_hang_state;
CREATE PERFETTO VIEW argent_hang_state AS
SELECT
  hw.hang_index                     AS hang_index,
  'state'                           AS row_kind,
  ts.state                          AS state_v,
  ts.blocked_function               AS blocked_function_v,
  CAST(SUM(ts.dur) AS TEXT)         AS total_dur_ns_v,
  CAST(COUNT(*)    AS TEXT)         AS occurrences_v,
  NULL                              AS gc_reason_v,
  NULL                              AS gc_ts_ns_v,
  NULL                              AS gc_dur_ns_v
FROM argent_hang_windows hw
JOIN thread_state ts ON ts.ts BETWEEN hw.start_ns AND hw.end_ns
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = '${opts.target}'
  AND t.is_main_thread
GROUP BY hw.hang_index, ts.state, ts.blocked_function;

DROP VIEW IF EXISTS argent_hang_gc;
CREATE PERFETTO VIEW argent_hang_gc AS
SELECT
  hw.hang_index                     AS hang_index,
  'gc'                              AS row_kind,
  NULL                              AS state_v,
  NULL                              AS blocked_function_v,
  NULL                              AS total_dur_ns_v,
  NULL                              AS occurrences_v,
  s.name                            AS gc_reason_v,
  CAST(s.ts  AS TEXT)               AS gc_ts_ns_v,
  CAST(s.dur AS TEXT)               AS gc_dur_ns_v
FROM argent_hang_windows hw
JOIN slice s
  ON s.ts < hw.end_ns AND s.ts + s.dur > hw.start_ns
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = '${opts.target}'
  AND t.is_main_thread
  AND s.name GLOB 'GC*';

SELECT * FROM argent_hang_state
UNION ALL
SELECT * FROM argent_hang_gc
ORDER BY hang_index, row_kind;
`;

  interface BatchRow {
    hang_index: number;
    row_kind: "state" | "gc";
    state_v: string | null;
    blocked_function_v: string | null;
    total_dur_ns_v: string | number | null;
    occurrences_v: string | number | null;
    gc_reason_v: string | null;
    gc_ts_ns_v: string | number | null;
    gc_dur_ns_v: string | number | null;
  }

  const rows = await runTpInline<BatchRow>({ tracePath: opts.tracePath, sql });

  const result: HangFoldsBatched = { state: new Map(), gc: new Map() };
  for (const row of rows) {
    if (row.row_kind === "state") {
      const total_dur_ns = toFiniteNumber(row.total_dur_ns_v);
      const occurrences = toFiniteNumber(row.occurrences_v);
      if (total_dur_ns == null || occurrences == null || row.state_v == null) continue;
      const list = result.state.get(row.hang_index) ?? [];
      list.push({
        state: row.state_v,
        blocked_function: row.blocked_function_v,
        total_dur_ns,
        occurrences,
      });
      result.state.set(row.hang_index, list);
    } else if (row.row_kind === "gc") {
      const ts_ns = toFiniteNumber(row.gc_ts_ns_v);
      const dur_ns = toFiniteNumber(row.gc_dur_ns_v);
      if (ts_ns == null || dur_ns == null || row.gc_reason_v == null) continue;
      const list = result.gc.get(row.hang_index) ?? [];
      list.push({ gc_reason: row.gc_reason_v, ts_ns, dur_ns });
      result.gc.set(row.hang_index, list);
    }
  }
  return result;
}

function assertSafeWindow(hang: HangWindowInput): void {
  if (
    !Number.isInteger(hang.hangIndex) ||
    !Number.isInteger(hang.startNs) ||
    !Number.isInteger(hang.endNs) ||
    hang.hangIndex < 0 ||
    hang.startNs < 0 ||
    hang.endNs < 0
  ) {
    throw new Error(
      `runBatchedHangFolds: refusing to inline non-integer/negative hang window: ${JSON.stringify(hang)}`
    );
  }
}

function validateTarget(target: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(target)) {
    throw new Error(
      `runBatchedHangFolds: refusing to substitute non-identifier-shaped process name into SQL: "${target}"`
    );
  }
}

function toFiniteNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
