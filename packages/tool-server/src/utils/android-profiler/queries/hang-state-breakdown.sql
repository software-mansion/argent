-- Argent — main-thread state breakdown during a single hang window.
--
-- Called once per UiHang from pipeline/hang-fold.ts. The aggregator folds
-- the rows back into the hang object as `stateBreakdown`.
--
-- iOS literally cannot produce this — Time Profiler only samples while a
-- thread is *running*, so a 500ms hang spent blocked on a futex shows up as
-- an empty sample window. ftrace gives us the partition for free.
--
-- Parameters substituted by run-tp.ts:
--   TARGET_PROCESS   — package / cmdline
--   HANG_START_NS    — hang window start, ns
--   HANG_END_NS      — hang window end, ns

SELECT
  state,
  blocked_function,
  SUM(dur) AS total_dur_ns,
  COUNT(*) AS occurrences
FROM thread_state ts
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'TARGET_PROCESS'
  AND t.is_main_thread
  AND ts.ts BETWEEN HANG_START_NS AND HANG_END_NS
GROUP BY state, blocked_function
ORDER BY total_dur_ns DESC;
