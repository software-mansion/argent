-- Argent — UI hangs
--
-- Merges two signals:
--   1. ANRs (5s+ input dispatch stalls) via the android.anrs stdlib module.
--      Always app-relevant — emitted verbatim.
--   2. Janky frames — frame_timeline rows where the app's own work missed the
--      frame deadline.
--
-- Jank policy: we keep ONLY frames whose jank_type includes "App Deadline
-- Missed" (the app blew its CPU budget for the frame). The framework's other
-- jank_type labels — "Prediction Error", "Buffer Stuffing", "SurfaceFlinger
-- CPU Deadline Missed" — are scheduler / SurfaceFlinger pipeline noise that
-- does not correspond to user-perceived app jank, and on a real trace they
-- outnumber app jank ~30:1 (1211 raw rows → ~43 app rows on a Bluesky trace).
-- The GLOB matches both the standalone "App Deadline Missed" and the
-- comma-combined forms ("Prediction Error, App Deadline Missed", etc.). If a
-- caller ever wants the scheduler noise back, relax the GLOB filter.
--
-- One frame can produce multiple actual_frame_timeline_slice rows (per-layer);
-- we GROUP BY the frame timestamp to emit one hang per frame, keeping the
-- longest slice duration and a representative jank_type / layer_name.
--
-- TARGET_PROCESS is substituted at runtime by run-tp.ts.

INCLUDE PERFETTO MODULE android.anrs;

SELECT
  'anr' AS kind,
  ts AS ts_ns,
  anr_dur_ms * 1000000 AS dur_ns,
  process_name,
  subject AS reason,
  error_id AS error_id
FROM android_anrs
WHERE process_name = 'TARGET_PROCESS'

UNION ALL

SELECT
  'jank' AS kind,
  aft.ts AS ts_ns,
  MAX(aft.dur) AS dur_ns,
  p.name AS process_name,
  MAX(aft.jank_type) AS reason,
  MAX(aft.layer_name) AS error_id
FROM actual_frame_timeline_slice aft
JOIN process p ON aft.upid = p.upid
WHERE p.name = 'TARGET_PROCESS'
  AND aft.jank_type != 'None'
  AND aft.jank_type GLOB '*App Deadline Missed*'
GROUP BY aft.ts, p.name

ORDER BY ts_ns;
