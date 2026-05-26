-- Argent — CPU hotspots
--
-- Per-(thread, leaf_function) grouping of perf_sample rows for the target
-- process. The aggregator picks dominant function (already done by the SQL
-- leaf), normalises the thread name, and applies severity bands.
--
-- TARGET_PROCESS is substituted at runtime by run-tp.ts.
--
-- The total_samples column is repeated on every output row so the JS side
-- can compute weight % without a second round-trip.

DROP VIEW IF EXISTS argent_app_total_samples;
CREATE PERFETTO VIEW argent_app_total_samples AS
SELECT COUNT(*) AS total_samples
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'TARGET_PROCESS';

WITH samples AS (
  SELECT
    ps.id           AS sample_id,
    ps.ts           AS ts_ns,
    t.name          AS thread_name,
    t.is_main_thread AS is_main_thread,
    spc.name        AS leaf_function,
    sm.name         AS leaf_mapping
  FROM perf_sample ps
  JOIN thread t USING (utid)
  JOIN process p USING (upid)
  LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
  LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
  LEFT JOIN stack_profile_mapping  sm  ON spf.mapping    = sm.id
  WHERE p.name = 'TARGET_PROCESS'
)
SELECT
  thread_name,
  is_main_thread,
  leaf_function,
  leaf_mapping,
  COUNT(*) AS sample_count,
  MIN(ts_ns) AS first_ts_ns,
  MAX(ts_ns) AS last_ts_ns,
  GROUP_CONCAT(ts_ns) AS ts_array,
  (SELECT total_samples FROM argent_app_total_samples) AS total_samples
FROM samples
GROUP BY thread_name, leaf_function, leaf_mapping
ORDER BY sample_count DESC
LIMIT 200;
