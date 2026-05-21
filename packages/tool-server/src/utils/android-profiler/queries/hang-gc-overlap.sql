-- Argent — ART GC slices overlapping a single hang window.
--
-- Folded into the hang row's prose as "+N ms in GC" when overlap exists.
-- ART emits "GC: <cause>" slice names on the main thread via the `dalvik`
-- atrace category (already enabled in argent.tracecfg.pbtxt).
--
-- Parameters substituted by run-tp.ts:
--   TARGET_PROCESS   — package / cmdline
--   HANG_START_NS    — hang window start, ns
--   HANG_END_NS      — hang window end, ns

SELECT
  s.name AS gc_reason,
  s.ts AS ts_ns,
  s.dur AS dur_ns
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t USING (utid)
JOIN process p USING (upid)
WHERE p.name = 'TARGET_PROCESS'
  AND t.is_main_thread
  AND s.name GLOB 'GC*'
  AND s.ts < HANG_END_NS
  AND s.ts + s.dur > HANG_START_NS;
