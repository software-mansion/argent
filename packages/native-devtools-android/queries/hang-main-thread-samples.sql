-- Argent — main-thread CPU samples during a hang window.
--
-- Drill-down for profiler-stack-query mode=hang_stacks. Returns one row per
-- perf_sample on the main thread inside the hang window, with the full
-- callstack text unwound via experimental_slice_callstack.
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
WHERE p.name = (SELECT target_process FROM _argent_args)
  AND t.is_main_thread
  AND ps.ts BETWEEN (SELECT hang_start_ns FROM _argent_args)
                AND (SELECT hang_end_ns FROM _argent_args)
ORDER BY ts_ns;
