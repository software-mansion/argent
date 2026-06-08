# Android Pipeline Design

This is the "why" companion to `ANDROID_PROFILER_REFERENCE.md`. iOS has four
pipeline files (`xml-parser`, `01-correlate`, `02-aggregate`, `index`); Android
has two (`index.ts`, `hang-fold.ts`). This note records why.

---

## 1. Why two files, not four

iOS's four-file shape exists because:

1. **XML parsing is bulky and benefits from isolation.** `xml-parser.ts` is ~360 lines of XPath/SAX-style parsing. Keeping it out of the correlation / aggregation files makes those readable.
2. **Correlation and aggregation are CPU-bound loops we want to test independently.** The pre-pass that picks a dominant function and normalises thread names runs on every sample; the hang-window correlation runs separately.

Android collapses (1) entirely: PerfettoSQL parses for us. The SQL's
`GROUP BY (thread_name, leaf_function)` already produces aggregator-ready rows.
And it partially collapses (2): the dominant-function "pick" is the leaf
function returned by SQL, so the iOS 3-tier picker (user code > 3rd-party >
RN framework > system) isn't needed.

What is left:

- **Row → Bottleneck transform** (`pipeline/index.ts`). Maps SQL rows to the
  platform-agnostic `Bottleneck` shape consumed by the render layer. Includes
  thread normalisation, severity banding, jank reason carry-through.
- **Per-hang fold** (`pipeline/hang-fold.ts` + `pipeline/hang-folds-batched.ts`).
  For each detected hang we need a main-thread state breakdown +
  GC-overlap annotation. These are computed in SQL by JOINing the
  `thread_state` and `slice` tables against a runtime
  `argent_hang_windows` table built from the hang list. The fold runs as
  a single SQL script via the warm WASM engine regardless of hang count;
  `hang-fold.ts` then merges the rows back into each
  `UiHang` object. The pure row → annotation merge lives in
  `hang-fold.ts` so it stays trivially testable.

Splitting these further would be cargo-culting iOS's shape onto a domain
where the work isn't there.

---

## 2. The shared aggregator hoist

The iOS file `pipeline/02-aggregate.ts` used to own the dominant-function
picker + thread normalisation + severity banding + burst windowing. The "pure
on row-shaped input → CpuHotspot[]" half of that logic was hoisted into
`utils/profiler-shared/aggregate.ts` so both backends call the same code.

iOS still owns its 3-tier dominant-function picker (it operates on
`StackFrame[]` with `isSystemLibrary` flags from the XML, which Android
doesn't have). The iOS path does a pre-pass that picks one dominant function
per sample, then hands an `AggregatorInputRow[]` to the shared aggregator.

Android skips the pre-pass entirely — the SQL leaf function is the dominant
function, and `thread_name` is already a string (no XML formatting to strip).

If you're adding a new platform later (Windows? a custom React Native fork?),
write a pre-pass into `AggregatorInputRow[]` and call the shared aggregator.
Don't fork it.

---

## 3. Drill-down: re-query, don't cache

iOS caches `parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks }`
in the session blueprint so `profiler-stack-query` can serve drill-down
modes from memory. The XML parser is expensive (~360 LoC, multiple table
walks per query), so re-running it per drill-down would be wasteful.

Android does the opposite: `api.parsedData = null` after analyze, and
`profiler-stack-query` re-runs the matching SQL file against the `.pftrace`
on each call. The in-process WASM engine keeps the trace warm per session
(loaded once, reused until the session is closed), so each drill-down query
costs only the SQL execution time (~ms) — not a full trace reload. The
engine is the cache; there is no value in also caching parsed rows.

If profile traces grow to the point where the analyze-stage fold queries
themselves slow down, the next move is to cache the per-hang fold rows
on disk (per-session JSON sidecars next to the `.pftrace`), not to mirror
the iOS in-memory cache.

---

## 4. The per-hang fold: batched, not looped

`runBatchedHangFolds` in `pipeline/hang-folds-batched.ts` is the entire
per-hang annotation pass. It:

1. Builds a `(hang_index, start_ns, end_ns)` tuple per hang from the
   `ui-hangs.sql` result, in the trace's NATIVE (CLOCK_MONOTONIC) ns
   domain.
2. Inlines them as a `VALUES (...)` table into a SQL script that creates
   `argent_hang_windows`, two derived `PERFETTO VIEW`s
   (`argent_hang_state` joining `thread_state`, `argent_hang_gc` joining
   `slice`), and a single terminal `UNION ALL` SELECT tagged with
   `row_kind` ∈ {'state','gc'}.
3. Runs the script as a single SQL string via `runTpInline` (the warm
   WASM engine). The trace is already loaded by the time the fold runs,
   so the fold pays only SQL execution time (~100 ms for 1000 hangs).
4. Demultiplexes the rows by `hang_index` and `row_kind` into two `Map`s,
   which `pipeline/index.ts` then hands to `foldHangAnnotations` per
   hang.

Two constraints drive the exact SQL shape:

- **The Perfetto engine returns only the final statement's result set.**
  Per-hang state and GC queries cannot be two separate top-level SELECTs
  — they must be materialised as VIEWs and unioned in one terminal
  SELECT. (Historical note: when the pipeline used `trace_processor_shell
  -q` subprocesses, this constraint was the error "Result rows were
  returned for multiples queries. Ensure that only the final statement
  is a SELECT statement." The WASM engine has the same behaviour.)
- **Perfetto SQL does not accept `VALUES (...) AS t(col1, col2)`** — the
  column-alias form. The script uses
  `SELECT column1 AS hang_index, column2 AS start_ns, column3 AS end_ns
  FROM (VALUES ...)`, leaning on SQLite's implicit `columnN` naming.

End-to-end against a 76 MB trace with 1013 jank rows: **6.3 s** total
(was: ~47 minutes projected when the pipeline forked one subprocess per
hang, never completed before the tool-call deadline).
