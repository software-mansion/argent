-- Argent — RSS growth weak signal.
--
-- NOT real leak detection: heap-dump-based leak detection lands in a later
-- phase. The analyze step tags this row as YELLOW and renders it under its
-- own "RSS Growth — Weak Signal" header with a "manual confirmation needed"
-- caveat (see render.ts).
--
-- Placeholder (declared in the _argent_args view below): target_process —
-- package / cmdline.
-- See README.md for the shared _argent_args / template-token conventions.

INCLUDE PERFETTO MODULE android.memory.process;

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT '{{TARGET_PROCESS}}' AS target_process;

SELECT
  process_name,
  MIN(anon_rss + file_rss) / 1048576.0 AS start_rss_mb,
  MAX(anon_rss + file_rss) / 1048576.0 AS peak_rss_mb,
  (MAX(anon_rss + file_rss) - MIN(anon_rss + file_rss)) / 1048576.0 AS growth_mb,
  MAX(anon_rss) / 1048576.0 AS peak_anon_rss_mb,
  MAX(swap) / 1048576.0 AS peak_swap_mb
FROM memory_oom_score_with_rss_and_swap_per_process
WHERE process_name = (SELECT target_process FROM _argent_args)
GROUP BY process_name;
