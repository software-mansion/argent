# Android Profiler Reference

Quick reference for the Perfetto-backed Android branch of `native-profiler-*`.
Mirrors `utils/ios-profiler/IOS_PROFILER_REFERENCE.md` for the iOS branch.

---

## 1. Stack

| Layer                       | What it is                                                                                       | Where in this repo                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `perfetto` (device-side)    | Recording daemon, built into the Android system image. Spawned via `adb shell perfetto`.         | Driven from `utils/android-profiler/capture.ts`                   |
| `traced` (device-side)      | Privileged trace muxer. Writes the output `.pftrace` under `/data/misc/perfetto-traces/`.        | Implicit — owned by Android                                       |
| `argent.tracecfg.pbtxt`     | TraceConfig (textproto) — names the data sources, buffer sizes, and per-target filters.          | `utils/android-profiler/argent.tracecfg.pbtxt`                    |
| `trace_processor_shell`     | On-host binary that runs PerfettoSQL queries against a `.pftrace`.                               | `@argent/native-devtools-android` → `bin/trace_processor_shell`   |
| `queries/*.sql`             | PerfettoSQL files — one per signal, with parameter placeholders substituted at runtime.          | `utils/android-profiler/queries/`                                 |
| `pipeline/index.ts`         | Drives `trace_processor_shell`, runs queries, folds rows into the shared `Bottleneck` shape.     | `utils/android-profiler/pipeline/index.ts`                        |

---

## 2. Capture

```
ADB shell                                 device
   │                                        │
   │ spawn `perfetto --txt -c -                       (stdin: TraceConfig textproto)
   │        --background-wait                         (wait for data sources to start)
   │        -o /data/misc/perfetto-traces/argent-<ts>.pftrace`
   │                                        │
   │ <───  PID prints on stdout once data sources are running
   │                                        │
   │ adb shell exits (stdin closed)         │  traced keeps recording
   │                                        │
   │ (user interaction)                     │
   │                                        │
   │ adb shell `kill -TERM <pid>`           │
   │ adb shell poll /proc/<pid> till gone   │
   │ adb pull <onDevicePath> <hostPath>     │
   │ adb shell `rm -f <onDevicePath>`       │
```

Two live constraints to remember:

- `/data/misc/perfetto-traces/` is `drwxrwx-wx` but SELinux denies `shell:s0` writes. The config CANNOT be staged via `cat > <path>` — it has to be piped to `perfetto` on stdin (`-c -`). `traced` writes the output as a privileged daemon, so the `.pftrace` lands fine.
- `--background-wait` prints the PID on stdout once all data sources are running. Tolerate warnings preceding the PID by taking the *last* non-empty stdout line.

---

## 3. Queries

| File                            | Purpose                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cpu-hotspots.sql`              | One row per (thread, leaf_function) with sample count + ts array. Aggregator picks dominant, normalises thread.    |
| `ui-hangs.sql`                  | `android_anrs` ∪ `actual_frame_timeline_slice` (jank). `reason` is `jank_type` for jank rows.                       |
| `hang-state-breakdown.sql`      | Per-hang main-thread state durations + `blocked_function`. Parameterised on `HANG_START_NS` / `HANG_END_NS`.        |
| `hang-gc-overlap.sql`           | ART GC slices overlapping the hang window. Folded into the hang row's prose, not its own report section.            |
| `memory-rss.sql`                | RSS growth across the recording. Weak signal — never reported as a leak, always YELLOW.                              |
| `thread-breakdown.sql`          | Per-thread sample count + % of app. Powers `profiler-stack-query` mode=thread_breakdown.                             |
| `function-callers.sql`          | Callstacks containing a given leaf function on a given thread. Powers `profiler-stack-query` mode=function_callers.  |
| `hang-main-thread-samples.sql`  | Main-thread perf_sample rows during a hang window, with unwound callstack text.                                      |

PerfettoSQL stdlib column-name drift is the main risk: when `trace_processor_shell` changes versions, column names in `android_anrs` / `actual_frame_timeline_slice` / `memory_oom_score_with_rss_and_swap_per_process` can rename. Pin the binary version in `scripts/download-native-binaries.sh` and add a fixture test on bumps.

---

## 4. The two-file pipeline (not iOS's four-file)

iOS has `pipeline/{xml-parser, 01-correlate, 02-aggregate, index}.ts` because:

1. XML parsing is bulky and benefits from isolation.
2. Correlation and aggregation are CPU-bound loops that pay off being tested independently.

Android collapses (1) entirely (PerfettoSQL parses for us) and partially collapses (2) (the SQL `GROUP BY` does the heavy lifting). The right Android shape is:

- `queries/*.sql` — declarative; what we want to know.
- `pipeline/index.ts` + `pipeline/hang-fold.ts` — imperative; row-to-Bottleneck transform + per-hang fold.

A reader who tries to mirror iOS's 4-file shape is making a mistake. Don't fork the shared aggregator — `utils/profiler-shared/aggregate.ts` is the single source of truth for the dominant-function / thread-normalisation / severity / burst-windowing logic.

---

## 5. Manifest requirement

Perfetto's `linux.perf` data source needs `/proc/<pid>/mem` read access. Android grants this to the target app's process only if:

- The app is built debuggable (`android:debuggable="true"` in the manifest), OR
- The app's manifest includes `<profileable android:shell="true"/>` under `<application>`.

A release build without either silently produces zero callstacks (samples appear in the trace but `stack_profile_callsite.name` is null, so `cpu-hotspots.sql` returns no rows). The pipeline detects this zero-sample case and emits a `manifest hint` in `exportErrors.cpu` instead of an "All clear" report.
