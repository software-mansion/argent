-- Argent — callers/callees for a single hot function.
--
-- Drill-down for profiler-stack-query mode=function_callers. Returns one row
-- per unique callsite that hits the requested function on the requested thread,
-- callstack text unwound via experimental_slice_callstack.
--
-- Parameters are injected once into the _argent_args view (by run-tp.ts) and
-- referenced by name in the body, instead of as bare tokens:
--   target_process — package / cmdline
--   thread_name    — normalised thread name
--   function_name  — leaf function

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT
  '{{TARGET_PROCESS}}' AS target_process,
  '{{THREAD_NAME}}'    AS thread_name,
  '{{FUNCTION_NAME}}'  AS function_name;

SELECT
  ps.callsite_id AS callsite_id,
  (
    SELECT GROUP_CONCAT(inner_spf.name, ' <- ' ORDER BY eac.depth DESC)
    FROM experimental_annotated_callstack(ps.callsite_id) eac
    LEFT JOIN stack_profile_frame inner_spf ON eac.frame_id = inner_spf.id
  ) AS callstack_text,
  COUNT(*) AS occurrences
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
WHERE p.name = (SELECT target_process FROM _argent_args)
  AND t.name = (SELECT thread_name FROM _argent_args)
  AND spf.name = (SELECT function_name FROM _argent_args)
GROUP BY ps.callsite_id
ORDER BY occurrences DESC
LIMIT 50;
