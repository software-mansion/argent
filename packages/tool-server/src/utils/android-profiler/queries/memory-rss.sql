-- Argent — RSS growth weak signal.
--
-- NOT real leak detection: heap-dump-based leak detection lands in a later
-- phase. The analyze step tags this row as YELLOW and renders it under its
-- own "RSS Growth — Weak Signal" header with a "manual confirmation needed"
-- caveat (see render.ts).
--
-- TARGET_PROCESS is substituted at runtime by run-tp.ts.

INCLUDE PERFETTO MODULE android.memory.process;

SELECT
  process_name,
  MIN(anon_rss + file_rss) / 1024.0 AS start_rss_mb,
  MAX(anon_rss + file_rss) / 1024.0 AS peak_rss_mb,
  (MAX(anon_rss + file_rss) - MIN(anon_rss + file_rss)) / 1024.0 AS growth_mb,
  MAX(anon_rss) / 1024.0 AS peak_anon_rss_mb,
  MAX(swap) / 1024.0 AS peak_swap_mb
FROM memory_oom_score_with_rss_and_swap_per_process
WHERE process_name = 'TARGET_PROCESS'
GROUP BY process_name;
