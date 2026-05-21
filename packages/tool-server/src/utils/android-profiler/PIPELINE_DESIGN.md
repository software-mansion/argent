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
- **Per-hang fold** (`pipeline/hang-fold.ts`). For each detected hang we run
  two additional queries (`hang-state-breakdown.sql`, `hang-gc-overlap.sql`)
  and fold the rows back into the hang object. Kept in its own file so the
  N+1 query loop is testable in isolation.

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
on each call. `trace_processor_shell` is fast (~30 ms per query against a
multi-MB trace), so the overhead is well below the round-trip cost of caching
hundreds of thousands of perf_sample rows in JS memory.

This is the v1 architecture; if profile traces ever grow to the point where
re-query becomes slow, the move is to cache the rows on disk (per-session
JSON sidecars next to the `.pftrace`), not to mirror the iOS in-memory cache.
