-- Argent — CPU hotspots.
--
-- One output row per (thread_name, leaf_function) — the leaf frame name IS the
-- dominant function, so one SQL row maps 1:1 to one aggregateCpuHotspots group.
-- The aggregator normalises the thread name and applies severity bands.
--
-- We ALSO carry the leaf frame's mapping (the loaded object the symbol lives in,
-- e.g. `/system/lib64/libhwui.so` for app/framework code or `/kernel` for kernel
-- frames) through to the classifier. Name patterns alone can't tell `writel`
-- (a kernel MMIO write) from app code, but the mapping can: a leaf in `/kernel`
-- is unambiguously system/emulator overhead. To keep one output row per
-- (thread_name, leaf_function) — so the SQL→aggregator 1:1 mapping is preserved
-- and the grouping is NOT fragmented — the mapping is folded in with MIN() (a
-- given leaf symbol resolves to a single mapping in practice, so MIN is just a
-- grouping-safe pick, not a lossy aggregate).
--
-- Burst windows are computed here in SQL rather than shipping every sample
-- timestamp (the old `GROUP_CONCAT(ts_ns)` shipped ~54 KB of timestamps that
-- JS re-parsed). A "burst" is a run of samples for the same (thread, function)
-- with no gap larger than the burst threshold. LAG() finds the gaps, a running
-- SUM() assigns burst ids, and we emit one `start_ms:end_ms:count` triple per
-- burst. start_ms/end_ms are native ms (README.md, "Timestamps"); the JS side
-- subtracts traceStartMs to make them trace-relative.
--
-- The total_samples column is repeated on every output row so the JS side can
-- compute weight % without a second round-trip.
--
-- Placeholders (declared in the _argent_args view below): target_process —
-- package / cmdline; burst_gap_ns — burst gap threshold in ns (BURST_GAP_MS ×
-- 1e6 from aggregate.ts, so the SQL and iOS-JS burst paths share one constant).
-- See README.md for the shared _argent_args / template-token conventions.

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT
  '{{TARGET_PROCESS}}' AS target_process,
  {{BURST_GAP_NS}}     AS burst_gap_ns;

DROP VIEW IF EXISTS argent_app_total_samples;
CREATE PERFETTO VIEW argent_app_total_samples AS
SELECT COUNT(*) AS total_samples
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = (SELECT target_process FROM _argent_args);

WITH samples AS (
  SELECT
    ps.ts            AS ts_ns,
    t.name           AS thread_name,
    t.is_main_thread AS is_main_thread,
    spf.name         AS leaf_function,
    spm.name         AS leaf_mapping
  FROM perf_sample ps
  JOIN thread t USING (utid)
  JOIN process p USING (upid)
  LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
  LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
  LEFT JOIN stack_profile_mapping  spm ON spf.mapping    = spm.id
  WHERE p.name = (SELECT target_process FROM _argent_args)
),
-- Flag each sample whose gap to the previous sample of the same
-- thread+function exceeds the burst threshold. LAG over the first sample is
-- NULL, so its CASE yields 0 — the opening sample never counts as a gap.
flagged AS (
  SELECT
    thread_name, is_main_thread, leaf_function, leaf_mapping, ts_ns,
    CASE
      WHEN ts_ns - LAG(ts_ns) OVER w > (SELECT burst_gap_ns FROM _argent_args) THEN 1
      ELSE 0
    END AS is_new_burst
  FROM samples
  WINDOW w AS (PARTITION BY thread_name, leaf_function ORDER BY ts_ns)
),
-- Running sum of the gap flags == a monotonically increasing burst id within
-- each thread+function partition.
ided AS (
  SELECT
    thread_name, is_main_thread, leaf_function, leaf_mapping, ts_ns,
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
-- leaf_mapping is grouping-invariant per (thread, function), so MIN() picks it
-- without affecting the per-burst cardinality.
per_burst AS (
  SELECT
    thread_name, leaf_function,
    MAX(is_main_thread) AS is_main_thread,
    MIN(leaf_mapping)   AS leaf_mapping,
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
  -- One mapping per (thread, function) group; MIN() keeps cardinality 1:1 with
  -- the existing GROUP BY so the grouping is not fragmented.
  MIN(leaf_mapping)   AS leaf_mapping,
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
