-- Argent — batched per-hang annotation (state breakdown + GC overlap).
--
-- Computes the main-thread state breakdown AND the ART GC overlap for EVERY
-- hang window in a single trace_processor_shell invocation, rather than
-- looping one invocation per hang (which paid the ~1.3 s trace-load cost N
-- times). The per-hang work moves into a JOIN over a runtime-built
-- `argent_hang_windows` table.
--
-- This is the single source of truth for the batched analyze path. The
-- `argent_hang_state` view below mirrors the standalone, single-window
-- `hang-state-breakdown.sql` (used by the drill-down path) — KEEP THE TWO
-- STATE QUERIES CONSISTENT: the window-clipping math (point 4 of the
-- SQL-hardening plan) is duplicated in both and the sql-smoke test exercises
-- each. There is no standalone GC query any more; the GC overlap logic lives
-- here only (drill-down never surfaced GC).
--
-- Substituted by pipeline/hang-folds-batched.ts before running (this template
-- is loaded via traceProcessorQueriesDir(), NOT through runTpQuery's generic
-- substitution map). The TS replaces:
--   * the single-quoted TARGET_PROCESS token with the validated package name;
--   * the bare placeholder inside `FROM (VALUES ...)` below with
--     `(hang_index, start_ns, end_ns)` tuples built from the hang list.
-- The windows placeholder must NOT appear anywhere else (e.g. in this header),
-- because its replacement spans multiple lines and would break a comment.

DROP TABLE IF EXISTS argent_hang_windows;
CREATE PERFETTO TABLE argent_hang_windows AS
SELECT
  column1 AS hang_index,
  column2 AS start_ns,
  column3 AS end_ns
FROM (VALUES
  HANG_WINDOWS_VALUES
);

DROP VIEW IF EXISTS argent_hang_state;
CREATE PERFETTO VIEW argent_hang_state AS
SELECT
  hw.hang_index                     AS hang_index,
  'state'                           AS row_kind,
  ts.state                          AS state_v,
  ts.blocked_function               AS blocked_function_v,
  -- Clip each thread_state slice to the hang window so a state that starts
  -- before the window or runs past its end contributes only the overlapping
  -- duration. Without this, SUM(ts.dur) over states whose START falls in the
  -- window can exceed the window length (SmartPerfetto time-interval JOIN).
  CAST(SUM(MIN(ts.ts + ts.dur, hw.end_ns) - MAX(ts.ts, hw.start_ns)) AS TEXT) AS total_dur_ns_v,
  CAST(COUNT(*)    AS TEXT)         AS occurrences_v,
  NULL                              AS gc_reason_v,
  NULL                              AS gc_ts_ns_v,
  NULL                              AS gc_dur_ns_v
FROM argent_hang_windows hw
JOIN thread_state ts
  ON ts.ts < hw.end_ns AND ts.ts + ts.dur > hw.start_ns
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'TARGET_PROCESS'
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
WHERE p.name = 'TARGET_PROCESS'
  AND t.is_main_thread
  AND s.name GLOB 'GC*';

SELECT * FROM argent_hang_state
UNION ALL
SELECT * FROM argent_hang_gc
ORDER BY hang_index, row_kind;
