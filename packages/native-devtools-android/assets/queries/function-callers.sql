-- Argent — callers/callees for a single hot function.
--
-- Drill-down for profiler-stack-query mode=function_callers. Returns one row
-- per unique callsite (+ owning thread) whose LEAF frame matches the requested
-- function, callstack text unwound via experimental_annotated_callstack.
--
-- Function matching is a literal, case-sensitive SUBSTRING test (INSTR), not
-- exact equality: perf frame names are stored MANGLED (e.g. the source symbol
-- "uncompressLZW" lives inside "_Z13uncompressLZWP7_JNIEnv..."), so an exact
-- match on a demangled name would miss. The Itanium length prefix means the
-- bare symbol still appears verbatim, so a substring catches it. matched_function
-- exposes the real leaf name and is_exact flags the rows that matched verbatim
-- (ordered first) so a precise query isn't drowned by incidental substrings.
--
-- Thread filter (the thread_name placeholder), resolved caller-side:
--   '__ALL__'   → all threads; each row is labelled with its thread so the
--                 caller can see where the function runs without knowing names.
--   '__MAIN__'  → the UI/main thread, matched via thread.is_main_thread. The
--                 main thread's raw perf `comm` is the truncated package
--                 (e.g. ".blueskyweb.app"), never the literal "main", so a
--                 name match would silently miss it.
--   <name>      → exact thread name match (raw perf `comm`).
-- Sentinels are upper-snake so they can't collide with a real comm name.
--
-- Placeholders (declared in the _argent_args view below): target_process —
-- package / cmdline; thread_name — see above; function_name — leaf function.
-- See README.md for the shared _argent_args / template-token conventions.

DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT
  '{{TARGET_PROCESS}}' AS target_process,
  '{{THREAD_NAME}}'    AS thread_name,
  '{{FUNCTION_NAME}}'  AS function_name;

SELECT
  t.name AS thread_name,
  MAX(t.is_main_thread) AS is_main_thread,
  spf.name AS matched_function,
  (spf.name = (SELECT function_name FROM _argent_args)) AS is_exact,
  (
    SELECT GROUP_CONCAT(inner_spf.name, ' <- ' ORDER BY eac.depth DESC)
    FROM experimental_annotated_callstack(ps.callsite_id) eac
    LEFT JOIN stack_profile_frame inner_spf ON eac.frame_id = inner_spf.id
  ) AS callstack_text,
  COUNT(*) AS occurrences
FROM perf_sample ps
JOIN thread t USING (utid)
JOIN process p USING (upid)
LEFT JOIN stack_profile_callsite spc ON ps.callsite_id = spc.id
LEFT JOIN stack_profile_frame    spf ON spc.frame_id   = spf.id
WHERE p.name = (SELECT target_process FROM _argent_args)
  AND spf.name IS NOT NULL
  AND INSTR(spf.name, (SELECT function_name FROM _argent_args)) > 0
  AND (
    (SELECT thread_name FROM _argent_args) = '__ALL__'
    OR ((SELECT thread_name FROM _argent_args) = '__MAIN__' AND t.is_main_thread = 1)
    OR t.name = (SELECT thread_name FROM _argent_args)
  )
GROUP BY ps.callsite_id, t.name, spf.name
ORDER BY is_exact DESC, occurrences DESC
LIMIT 50;
