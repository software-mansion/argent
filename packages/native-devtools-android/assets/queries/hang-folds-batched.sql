-- Argent — batched per-hang annotation (state breakdown + GC overlap).
--
-- Computes the main-thread state breakdown AND ART GC overlap for EVERY hang
-- window in ONE batched trace-processor query, via a JOIN over the
-- runtime-built `argent_hang_windows` table instead of looping one query
-- per hang. See README.md, "One trace parse per warm engine → batch".
--
-- Single source of truth for the batched analyze path. The `argent_hang_state`
-- view below mirrors the standalone, single-window `hang-state-breakdown.sql`
-- (drill-down) — keep the two consistent (README.md, "Two copies of the hang
-- state breakdown"). There is no standalone GC query; GC overlap lives here
-- only (drill-down never surfaced GC).
--
-- Loaded directly by pipeline/hang-folds-batched.ts, not the generic runTpQuery
-- path.
--
-- Placeholders: target_process (declared in the _argent_args view below); and a
-- hang-windows token in the `FROM (VALUES ...)` below, which the TS replaces
-- with one `(hang_index, start_ns, end_ns)` tuple per hang. That windows token
-- must NOT appear anywhere else (e.g. this header): its replacement spans
-- multiple lines and would break a comment, so it is referenced only obliquely.
-- See README.md for the shared _argent_args / template-token conventions.

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT '{{TARGET_PROCESS}}' AS target_process;

DROP TABLE IF EXISTS argent_hang_windows;
CREATE PERFETTO TABLE argent_hang_windows AS
SELECT
  column1 AS hang_index,
  column2 AS start_ns,
  column3 AS end_ns
FROM (VALUES
  {{HANG_WINDOWS_VALUES}}
);

DROP VIEW IF EXISTS argent_hang_state;
CREATE PERFETTO VIEW argent_hang_state AS
SELECT
  hw.hang_index                     AS hang_index,
  'state'                           AS row_kind,
  ts.state                          AS state_v,
  ts.blocked_function               AS blocked_function_v,
  -- Clip each thread_state slice to the hang window so a state that begins
  -- before the window or extends past its end contributes only the overlapping
  -- duration. Plain SUM(dur) over states whose START falls in the window can
  -- otherwise exceed the window length (SmartPerfetto time-interval JOIN).
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
WHERE p.name = (SELECT target_process FROM _argent_args)
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
WHERE p.name = (SELECT target_process FROM _argent_args)
  AND t.is_main_thread
  AND s.name GLOB 'GC*';

SELECT * FROM argent_hang_state
UNION ALL
SELECT * FROM argent_hang_gc
ORDER BY hang_index, row_kind;
