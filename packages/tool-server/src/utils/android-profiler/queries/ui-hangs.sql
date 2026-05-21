-- Argent — UI hangs
--
-- Merges two signals:
--   1. ANRs (5s+ input dispatch stalls) via the android.anrs stdlib module.
--   2. Janky frames — frame_timeline rows where jank_type is set and the
--      actual frame missed the expected deadline.
--
-- TARGET_PROCESS is substituted at runtime by run-tp.ts.

INCLUDE PERFETTO MODULE android.anrs;

SELECT
  'anr' AS kind,
  ts AS ts_ns,
  dur AS dur_ns,
  process_name,
  subject AS reason,
  error_id AS error_id
FROM android_anrs
WHERE process_name = 'TARGET_PROCESS'

UNION ALL

SELECT
  'jank' AS kind,
  aft.ts AS ts_ns,
  aft.dur AS dur_ns,
  p.name AS process_name,
  aft.jank_type AS reason,
  aft.layer_name AS error_id
FROM actual_frame_timeline_slice aft
JOIN process p ON aft.upid = p.upid
WHERE p.name = 'TARGET_PROCESS'
  AND aft.jank_type != 'None'

ORDER BY ts_ns;
