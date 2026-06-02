-- Argent — per-thread CPU breakdown.
--
-- Powers profiler-stack-query mode=thread_breakdown for Android sessions.
-- Returns sample_count + share of total per thread.
--
-- The target process is injected once into the _argent_args view (by
-- run-tp.ts) and referenced by name below, instead of as a bare token.

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT '{{TARGET_PROCESS}}' AS target_process;

WITH per_thread AS (
  SELECT
    t.name AS thread_name,
    t.is_main_thread AS is_main_thread,
    COUNT(ps.id) AS sample_count
  FROM perf_sample ps
  JOIN thread t USING (utid)
  JOIN process p USING (upid)
  WHERE p.name = (SELECT target_process FROM _argent_args)
  GROUP BY t.name, t.is_main_thread
),
total AS (
  SELECT SUM(sample_count) AS total_samples FROM per_thread
)
SELECT
  thread_name,
  is_main_thread,
  sample_count,
  ROUND(100.0 * sample_count / (SELECT total_samples FROM total), 2) AS pct_of_app
FROM per_thread
ORDER BY sample_count DESC;
