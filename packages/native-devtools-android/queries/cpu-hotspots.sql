-- Argent — CPU hotspots
--
-- One output row per (thread_name, leaf_function) — the leaf frame name IS the
-- dominant function, so one SQL row maps 1:1 to one aggregateCpuHotspots group
-- (we drop leaf_mapping, which was unused and only fragmented the grouping).
-- The aggregator normalises the thread name and applies severity bands.
--
-- Burst windows are computed here in SQL rather than shipping every sample
-- timestamp (the old `GROUP_CONCAT(ts_ns)` shipped ~54 KB of timestamps that
-- JS re-parsed). A "burst" is a run of samples for the same (thread, function)
-- with no >500ms gap (BURST_GAP_MS in aggregate.ts). LAG() finds the gaps,
-- a running SUM() assigns burst ids, and we emit one `start_ms:end_ms:count`
-- triple per burst. start_ms/end_ms are NATIVE (CLOCK_MONOTONIC) ms; the JS
-- side subtracts traceStartMs to make them trace-relative.
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
    ps.ts            AS ts_ns,
    t.name           AS thread_name,
    t.is_main_thread AS is_main_thread,
    spf.name         AS leaf_function
  FROM perf_sample ps
  JOIN thread t USING (utid)
  JOIN process p USING (upid)
  LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
  LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
  WHERE p.name = 'TARGET_PROCESS'
),
-- Flag each sample that opens a new burst (>500ms = 500000000ns since the
-- previous sample of the same thread+function). LAG over the first sample is
-- NULL, so its CASE yields 0 — the opening sample never counts as a gap.
flagged AS (
  SELECT
    thread_name, is_main_thread, leaf_function, ts_ns,
    CASE
      WHEN ts_ns - LAG(ts_ns) OVER w > 500000000 THEN 1
      ELSE 0
    END AS is_new_burst
  FROM samples
  WINDOW w AS (PARTITION BY thread_name, leaf_function ORDER BY ts_ns)
),
-- Running sum of the gap flags == a monotonically increasing burst id within
-- each thread+function partition.
ided AS (
  SELECT
    thread_name, is_main_thread, leaf_function, ts_ns,
    SUM(is_new_burst) OVER (
      PARTITION BY thread_name, leaf_function
      ORDER BY ts_ns
      ROWS UNBOUNDED PRECEDING
    ) AS burst_id
  FROM flagged
),
-- Collapse each burst to [start_ns, end_ns, sample_count]. Every sample lands
-- in exactly one burst, so summing burst counts == total samples and
-- MIN/MAX of burst bounds == first/last sample of the (thread, function).
per_burst AS (
  SELECT
    thread_name, leaf_function,
    MAX(is_main_thread) AS is_main_thread,
    MIN(ts_ns)          AS burst_start_ns,
    MAX(ts_ns)          AS burst_end_ns,
    COUNT(*)            AS burst_count
  FROM ided
  GROUP BY thread_name, leaf_function, burst_id
)
SELECT
  thread_name,
  MAX(is_main_thread) AS is_main_thread,
  leaf_function,
  SUM(burst_count)    AS sample_count,
  MIN(burst_start_ns) AS first_ts_ns,
  MAX(burst_end_ns)   AS last_ts_ns,
  (SELECT total_samples FROM argent_app_total_samples) AS total_samples,
  -- Compact `start_ms:end_ms:count` triples, comma-separated. JS sorts them
  -- by start before display, so GROUP_CONCAT order is irrelevant.
  GROUP_CONCAT(
    (burst_start_ns / 1000000) || ':' || (burst_end_ns / 1000000) || ':' || burst_count,
    ','
  ) AS burst_windows
FROM per_burst
GROUP BY thread_name, leaf_function
ORDER BY sample_count DESC
LIMIT 200;
