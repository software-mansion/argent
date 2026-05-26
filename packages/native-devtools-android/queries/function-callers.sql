-- Argent — callers/callees for a single hot function.
--
-- Drill-down for profiler-stack-query mode=function_callers. Returns one row
-- per unique callsite that hits FUNCTION_NAME on THREAD_NAME, with the full
-- callstack text unwound via experimental_slice_callstack.
--
-- Parameters substituted by run-tp.ts:
--   TARGET_PROCESS  — package / cmdline
--   THREAD_NAME     — normalised thread name
--   FUNCTION_NAME   — leaf function

SELECT
  ps.callsite_id AS callsite_id,
  experimental_slice_callstack(ps.callsite_id) AS callstack_text,
  COUNT(*) AS occurrences
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
WHERE p.name = 'TARGET_PROCESS'
  AND t.name = 'THREAD_NAME'
  AND spc.name = 'FUNCTION_NAME'
GROUP BY ps.callsite_id
ORDER BY occurrences DESC
LIMIT 50;
