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
  spf.name AS leaf_function,
  (
    SELECT GROUP_CONCAT(inner_spf.name, ' <- ' ORDER BY eac.depth DESC)
    FROM experimental_annotated_callstack(ps.callsite_id) eac
    LEFT JOIN stack_profile_frame inner_spf ON eac.frame_id = inner_spf.id
  ) AS callstack_text
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
WHERE p.name = 'TARGET_PROCESS'
  AND t.is_main_thread
  AND ps.ts BETWEEN HANG_START_NS AND HANG_END_NS
ORDER BY ts_ns;
