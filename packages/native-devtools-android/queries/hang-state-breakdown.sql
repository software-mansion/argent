-- Argent — main-thread state breakdown during a single hang window.
--
-- Called once per UiHang from the drill-down path (pipeline/index.ts
-- renderHangStacksAndroid). The aggregator folds the rows back into the hang
-- object as `stateBreakdown`.
--
-- iOS literally cannot produce this — Time Profiler only samples while a
-- thread is *running*, so a 500ms hang spent blocked on a futex shows up as
-- an empty sample window. ftrace gives us the partition for free.
--
-- This is the single-window twin of the `argent_hang_state` view in
-- `hang-folds-batched.sql` (the batched analyze path). KEEP THE TWO STATE
-- QUERIES CONSISTENT — both clip slice durations to the window (see below).
--
-- Parameters are injected once into the _argent_args view (by run-tp.ts) and
-- referenced by name in the body, instead of as bare tokens:
--   target_process — package / cmdline
--   hang_start_ns  — hang window start, ns
--   hang_end_ns    — hang window end, ns

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT
  '{{TARGET_PROCESS}}' AS target_process,
  {{HANG_START_NS}}    AS hang_start_ns,
  {{HANG_END_NS}}      AS hang_end_ns;

SELECT
  state,
  blocked_function,
  -- Clip each thread_state slice to the window so a state that begins before
  -- the window or extends past its end contributes only the overlapping
  -- duration. Plain SUM(dur) over states whose START falls in the window can
  -- otherwise exceed the window length (SmartPerfetto time-interval JOIN).
  SUM(MIN(ts.ts + ts.dur, (SELECT hang_end_ns FROM _argent_args))
      - MAX(ts.ts, (SELECT hang_start_ns FROM _argent_args))) AS total_dur_ns,
  COUNT(*) AS occurrences
FROM thread_state ts
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = (SELECT target_process FROM _argent_args)
  AND t.is_main_thread
  AND ts.ts < (SELECT hang_end_ns FROM _argent_args)
  AND ts.ts + ts.dur > (SELECT hang_start_ns FROM _argent_args)
GROUP BY state, blocked_function
ORDER BY total_dur_ns DESC;
