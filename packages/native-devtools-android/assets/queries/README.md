# Argent Android profiler — PerfettoSQL queries

These `*.sql` files are the source of truth for every query the Argent Android
native profiler runs against a captured `.pftrace`. They run through the
in-process Perfetto WASM trace-processor from the tool-server pipeline
(`runTpQuery` / `runTpInline` in
`tool-server/src/utils/android-profiler/pipeline/run-tp.ts`).

The directory lives in `native-devtools-android`; the bundler copies it next to
the bundled tool-server at publish time, so `traceProcessorQueriesDir()` resolves
the same path in dev and packaged builds.

Each `.sql` header documents only what's specific to that query. The shared
conventions live here so they aren't repeated nine times.

## What each file is for

| File                           | Consumed by                                  | Purpose                                                          |
| ------------------------------ | -------------------------------------------- | ---------------------------------------------------------------- |
| `trace-bounds.sql`             | every analyze run                            | Trace start timestamp anchor (see _Timestamps_).                 |
| `ui-hangs.sql`                 | analyze                                      | ANRs + app-jank frames → one hang per frame.                     |
| `cpu-hotspots.sql`             | analyze                                      | Per-thread hottest leaf functions + burst windows.               |
| `thread-breakdown.sql`         | profiler-stack-query `mode=thread_breakdown` | Per-thread sample share.                                         |
| `hang-folds-batched.sql`       | batched analyze                              | State breakdown + GC overlap for ALL hangs in one batched query. |
| `hang-state-breakdown.sql`     | drill-down (single hang)                     | Main-thread state breakdown for one hang window.                 |
| `hang-main-thread-samples.sql` | profiler-stack-query `mode=hang_stacks`      | Main-thread CPU samples inside one hang window.                  |
| `function-callers.sql`         | profiler-stack-query `mode=function_callers` | Callsites that hit one hot function.                             |
| `memory-rss.sql`               | analyze                                      | RSS-growth weak signal (not leak detection).                     |

## Conventions

### Parameters via the `_argent_args` view

Each query declares its runtime parameters once in a small `_argent_args`
PERFETTO VIEW at the top, then references them by name:

```sql
DROP VIEW IF EXISTS _argent_args;
CREATE PERFETTO VIEW _argent_args AS
SELECT '{{TARGET_PROCESS}}' AS target_process;
...
WHERE p.name = (SELECT target_process FROM _argent_args)
```

This keeps each value at one self-documenting site, and the body reads like
normal SQL instead of scattering bare tokens through it.

### `{{NAME}}` template tokens

`{{NAME}}` placeholders are resolved by `renderSqlTemplate` (`run-tp.ts`) before
the query runs. It throws on a mismatch either way: a `{{NAME}}` with no
substitution, or a substitution the template never uses — catching forgotten or
stale tokens early.

Values are **not** escaped for SQL injection — they're interpolated into the
query string passed to the in-process engine, so callers must validate them
(numeric for `*_ns`; identifier-shaped for process/thread/function names) — see
`hang-folds-batched.ts` for the strictest example.

Most queries render through `runTpQuery`. `hang-folds-batched.sql` is the
exception: `pipeline/hang-folds-batched.ts` loads it directly, builds the
`{{HANG_WINDOWS_VALUES}}` tuple list, and resolves it through the same renderer.

### Timestamps are CLOCK_MONOTONIC nanoseconds

Perfetto's `ts` columns are CLOCK_MONOTONIC nanoseconds since device boot — not
trace-relative. `trace-bounds.sql` returns the earliest `ts`; the JS side
subtracts it (`traceStartMs`) to normalise every emitted timestamp to
trace-relative ns. Any native ms/ns a query emits (burst windows, hang bounds)
stays native until JS does that subtraction.

### One trace parse per warm engine → batch

Re-parsing the whole trace on every query is expensive (~1.3 s for 76 MB), so
one query per item is quadratic — the per-hang loop this replaced took ~47 min
for 1013 hangs. Instead, fold many per-item queries into a single script with
`CREATE PERFETTO VIEW`/`TABLE` + a terminal `UNION ALL SELECT`, joining over a
runtime-built table. See `hang-folds-batched.sql`: one ~1.7 s run regardless of
hang count. Only the final SELECT reaches stdout.

### Two copies of the hang state breakdown — keep them in sync

The main-thread state-breakdown logic lives in two places:

- `hang-state-breakdown.sql` — single window, drill-down path;
- the `argent_hang_state` view in `hang-folds-batched.sql` — all windows.

Keep the window-clipping math in sync: each `thread_state` slice is clipped to
the hang window (`MIN(ts.ts + ts.dur, end) - MAX(ts.ts, start)`) so a slice
straddling a boundary only counts its overlap. A plain `SUM(dur)` over slices
that merely start inside the window can overshoot its length.

There's no standalone GC query — GC overlap lives only in the batched file.
