# Android Profiler Reference

Quick reference for the Perfetto-backed Android branch of `native-profiler-*`.
Mirrors `utils/ios-profiler/IOS_PROFILER_REFERENCE.md` for the iOS branch.

---

## 1. Stack

| Layer                       | What it is                                                                                       | Where in this repo                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `perfetto` (device-side)    | Recording daemon, built into the Android system image. Spawned via `adb shell perfetto`.         | Driven from `utils/android-profiler/capture.ts`                   |
| `traced` (device-side)      | Privileged trace muxer. Writes the output `.pftrace` under `/data/misc/perfetto-traces/`.        | Implicit — owned by Android                                       |
| `argent.tracecfg.pbtxt`     | TraceConfig (textproto) — names the data sources, buffer sizes, and per-target filters.          | `@argent/native-devtools-android` → `argent.tracecfg.pbtxt`       |
| `trace_processor_shell`     | On-host binary that runs PerfettoSQL queries against a `.pftrace`.                               | `@argent/native-devtools-android` → `bin/trace_processor_shell`   |
| `queries/*.sql`             | PerfettoSQL files — one per signal, with parameter placeholders substituted at runtime.          | `@argent/native-devtools-android` → `queries/`                    |
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

Per-query docs and the shared SQL conventions (`_argent_args` parameters,
`{{NAME}}` tokens, CLOCK_MONOTONIC timestamps, the batched-fold pattern) are the
source of truth in `queries/README.md`. Don't re-list them here.

PerfettoSQL stdlib column-name drift is the main risk: when `trace_processor_shell` changes versions, column names in `android_anrs` / `actual_frame_timeline_slice` / `memory_oom_score_with_rss_and_swap_per_process` can rename. Pin the binary version in `scripts/download-native-binaries.sh` and add a fixture test on bumps.

---

## 4. The two-file pipeline (not iOS's four-file)

PerfettoSQL parses and aggregates for us, so the Android branch needs only
`pipeline/index.ts` (row → `Bottleneck` transform) and `pipeline/hang-fold.ts`
(per-hang fold) — not iOS's four files. Don't mirror iOS's shape, and don't fork
the shared aggregator (`utils/profiler-shared/aggregate.ts`). See
`PIPELINE_DESIGN.md` for the full rationale.

---

## 5. Manifest requirement

Perfetto's `linux.perf` data source needs `/proc/<pid>/mem` read access. Android grants this to the target app's process only if:

- The app is built debuggable (`android:debuggable="true"` in the manifest), OR
- The app's manifest includes `<profileable android:shell="true"/>` under `<application>`.

A release build without either silently produces zero callstacks (samples appear in the trace but `stack_profile_callsite.name` is null, so `cpu-hotspots.sql` returns no rows). The pipeline detects this zero-sample case and emits a `manifest hint` in `exportErrors.cpu` instead of an "All clear" report.
