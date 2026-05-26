-- Argent — main-thread CPU samples during a hang window.
--
-- Drill-down for profiler-stack-query mode=hang_stacks. Returns one row per
-- perf_sample on the main thread inside the hang window, with the full
-- callstack text unwound via experimental_slice_callstack.
--
-- Parameters substituted by run-tp.ts:
--   TARGET_PROCESS  — package / cmdline
--   HANG_START_NS   — hang window start, ns
--   HANG_END_NS     — hang window end, ns

SELECT
  ps.ts AS ts_ns,
  spc.name AS leaf_function,
  experimental_slice_callstack(spc.id) AS callstack_text
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
WHERE p.name = 'TARGET_PROCESS'
  AND t.is_main_thread
  AND ps.ts BETWEEN HANG_START_NS AND HANG_END_NS
ORDER BY ts_ns;
