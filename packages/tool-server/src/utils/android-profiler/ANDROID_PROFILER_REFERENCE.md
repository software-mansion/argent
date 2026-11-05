# Android Profiler Reference

Quick reference for the Perfetto-backed Android branch of `native-profiler-*`.
Mirrors `utils/ios-profiler/IOS_PROFILER_REFERENCE.md` for the iOS branch.

---

## 1. Stack

| Layer                    | What it is                                                                                                                                                              | Where in this repo                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `perfetto` (device-side) | Recording daemon, built into the Android system image. Spawned via `adb shell perfetto`.                                                                                | Driven from `utils/android-profiler/capture.ts`                                                                       |
| `traced` (device-side)   | Privileged trace muxer. Writes the output `.pftrace` under `/data/misc/perfetto-traces/`.                                                                               | Implicit — owned by Android                                                                                           |
| `argent.tracecfg.pbtxt`  | TraceConfig (textproto) — names the data sources, buffer sizes, and per-target filters.                                                                                 | `@argent/native-devtools-android` → `argent.tracecfg.pbtxt`                                                           |
| Perfetto WASM engine     | In-process trace-processor (Perfetto compiled to WebAssembly) that runs PerfettoSQL against a `.pftrace`. No subprocess, no per-platform binary.                        | `@argent/native-devtools-android` → `src/wasm-trace-processor.ts` (`queryWarm`); wasm under `assets/trace-processor/` |
| `queries/*.sql`          | PerfettoSQL files — one per signal, with parameter placeholders substituted at runtime.                                                                                 | `@argent/native-devtools-android` → `queries/`                                                                        |
| `pipeline/index.ts`      | Drives the in-process WASM engine through `pipeline/run-tp.ts` (`runTpQuery`/`runTpInline` → `queryWarm`), runs queries, folds rows into the shared `Bottleneck` shape. | `utils/android-profiler/pipeline/index.ts`                                                                            |

---

## 2. Capture

```
ADB shell                                 device
   │                                        │
   │ adb shell `perfetto --help`            │  (choose the background flag)
   │ adb push <cfg> /data/local/tmp/argent-<ts>-<rand>.pbtxt
   │ spawn `cat <that path> | perfetto --txt -c -
   │        --background-wait                         (--background on Android 11 and older)
   │        -o /data/misc/perfetto-traces/argent-<ts>.pftrace`
   │                                        │
   │ <───  PID prints on stdout
   │                                        │
   │ adb shell exits                        │  traced keeps recording
   │ adb shell `rm -f <cfg path>`           │
   │                                        │
   │ (user interaction)                     │
   │                                        │
   │ adb shell `kill -TERM <pid>`           │
   │ adb shell poll /proc/<pid> till gone   │
   │ adb pull <onDevicePath> <hostPath>     │
   │ adb shell `rm -f <onDevicePath>`       │
```

Live constraints to remember:

- The config is pushed to `/data/local/tmp/` and piped into perfetto by the on-device shell. perfetto cannot open it there (SELinux), `shell:s0` cannot write `/data/misc/perfetto-traces/`, and `/data/misc/perfetto-configs/` only exists from Android 12. Piping from the host instead (`adb shell perfetto -c -` with the config on adb's stdin) needs adb to deliver end of input, which takes the `shell_v2` protocol: over a transport that does not advertise it, perfetto waits for more config forever.
- `--background-wait` prints the PID once all data sources are running. Android 11 and older only have `--background`, which prints it straight away, so a trace there can miss the first moments, and the capture checks that the daemon is still alive shortly afterwards. Tolerate warnings preceding the PID by taking the _last_ non-empty stdout line.
- Android 11 and older reject the `linux.perf` fields in the config, and one unknown field fails the whole config. When perfetto answers `No field named`, the capture retries without the section between the `ARGENT_CPU_SAMPLING` markers, so those traces have no CPU callstacks. The start result and the analysis report say so.
- Below Android 10 perfetto has no `--txt`, so native profiling fails with `NATIVE_PROFILER_PERFETTO_UNSUPPORTED`.

---

## 3. Queries

Per-query docs and the shared SQL conventions (`_argent_args` parameters,
`{{NAME}}` tokens, CLOCK_MONOTONIC timestamps, the batched-fold pattern) are the
source of truth in `queries/README.md`. Don't re-list them here.

PerfettoSQL stdlib column-name drift is the main risk: when the bundled Perfetto WASM engine changes versions, column names in `android_anrs` / `actual_frame_timeline_slice` / `memory_oom_score_with_rss_and_swap_per_process` can rename. The version is pinned in the `argent-private` submodule (`PERFETTO_VERSION` / `PERFETTO_WASM_TAG`), stamped into `bundled-meta.ts` at pack time, and the bundle is fetched + sha256-verified by `scripts/download-trace-processor.sh` — see `ANDROID_PERFETTO.md` for the bump procedure. Add a fixture test on bumps.

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
