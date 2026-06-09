# iOS Profiler — Reference

A concise overview of how Argent's iOS profiling works: what native machinery is invoked, what gets captured, how the data is processed, and what comes back to the agent.

For the deeper "why" of each pipeline decision, see `PIPELINE_DESIGN.md`. For day-to-day workflow, see the `argent-native-profiler` skill.

---

## 1. TL;DR

Argent profiles iOS by driving Apple's own profiling stack (`xctrace`/Instruments) from a Node tool server, then post-processing the trace into an LLM-friendly markdown report.

```
launch-app → native-profiler-start → (user/agent interacts) → native-profiler-stop → native-profiler-analyze → profiler-stack-query (drill-down) / profiler-combined-report (with React)
```

Three concerns are captured: **CPU hotspots**, **UI hangs**, and **memory leaks**. Each is summarised, classified RED/YELLOW, and accompanied by app call chains for actionability.

---

## 2. Native foundations

| Layer                       | What it is                                                                                                                         | How Argent uses it                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Instruments / `xctrace`** | Apple's tracing framework. `xctrace` is the headless CLI used by the Instruments app under the hood.                               | Every iOS profiling action is just an `xctrace record` / `xctrace export` invocation spawned by Argent.                                |
| **`.tracetemplate`**        | A binary plist describing which Instruments to attach and how to configure them.                                                   | Argent ships `Argent.tracetemplate`, passed via `xctrace record --template`.                                                           |
| **`xcrun simctl`**          | Simulator control. `simctl spawn ... launchctl list` enumerates running processes; `simctl listapps` enumerates installed bundles. | Used by `native-profiler-start` to auto-detect the foreground user app (`CFBundleExecutable`) so the user does not have to specify it. |
| **Trace bundle (`.trace`)** | The package `xctrace record` produces. Internally a SQLite-backed structure with per-instrument tables.                            | `xctrace export --xpath ...` extracts individual tables to XML for parsing.                                                            |

`xctrace` runs via `child_process.spawn`. The PID is held in the per-device session blueprint (`NativeProfilerSession`); SIGINT terminates recording cleanly so the trace bundle finalises.

---

## 3. What is recorded (bundled template)

`Argent.tracetemplate` enables the following Instruments. Identifiers are taken from the binary plist (`com.apple.xray.instrument-type.*` / `com.apple.dt-perfteam.*`):

| Instrument identifier                                 | Common name                                         | Used by Argent's pipeline?                                     |
| ----------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `com.apple.xray.instrument-type.coresampler2`         | **Time Profiler** (kernel-driven sampling profiler) | **Yes** — exported as the `time-profile` table → CPU hotspots. |
| `com.apple.dt-perfteam.hangs`                         | **Hangs** (main-thread responsiveness detector)     | **Yes** — exported as the `potential-hangs` table → UI hangs.  |
| `com.apple.xray.instrument-type.homeleaks`            | **Leaks** (periodic leak scan)                      | **Yes** — exported via the `Leaks` track → memory leaks.       |
| `com.apple.xray.instrument-type.oa`                   | **Allocations** (object lifetime + alloc tree)      | Recorded but currently not consumed.                           |
| `com.apple.xray.instrument-type.poi`                  | **Points of Interest** (`os_signpost`)              | Recorded but not consumed.                                     |
| `com.apple.xray.instrument-type.device-thermal-state` | **Thermal State**                                   | Recorded but not consumed.                                     |

> The hangs Instrument is the same engine that powers Xcode's "hang reports" — Apple's term for any stretch of time the main thread fails to service the run loop.

---

## 4. The three tools (capture flow)

All three are wired through `native-profiler-session` (per-device service, keyed by UDID).

### `native-profiler-start`

1. **Detect the target app** — runs `xcrun simctl spawn <udid> launchctl list`, parses `UIKitApplication:<bundleId>` lines, cross-references with `simctl listapps` to keep only `User` apps. Fails fast if zero or more than one app match.
2. **Resolve the template** — defaults to bundled `Argent.tracetemplate`, override via `template_path`.
3. **Spawn `xctrace record`**:
   ```
   xctrace record \
     --template <Argent.tracetemplate> \
     --device <udid> \
     --attach <CFBundleExecutable> \
     --output <tmpdir>/argent-profiler-cwd/ios-profiler-<ts>.trace
   ```
4. **Start gating** — only resolves the tool call once `xctrace` prints `Starting recording` / `Ctrl-C to stop` on stdout. At that point Argent records `Date.now()` (`wallClockStartMs`) — the anchor used later for cross-tool time alignment.
5. **Safety timeout** — auto-SIGINTs after 10 minutes if `stop` is never called.

### `native-profiler-stop`

1. `process.kill(xctracePid, "SIGINT")` and poll `process.kill(pid, 0)` until the child exits (xctrace needs a moment to finalise the trace bundle).
2. Run **schema-aware export**:
   - First call `xctrace export --toc` to discover what schemas the trace actually contains.
   - Pick the first match from `["time-profile", "cpu-profile", "time-sample"]` for CPU.
   - Fall back to brute-forcing each candidate if TOC parsing fails.
   - For Leaks, append `--hal` on `xctrace` ≥ 15 (required by newer xctrace versions for the leaks export); retry without the flag on failure for backward compatibility.
3. Three XMLs land next to the `.trace` bundle:
   - `<base>_raw_cpu.xml` — `time-profile` table
   - `<base>_raw_hangs.xml` — `potential-hangs` table
   - `<base>_raw_leaks.xml` — `Leaks` track detail
4. Returns `{ traceFile, exportedFiles, exportDiagnostics }`. `exportDiagnostics` carries the discovered schema list and any per-stream errors so the agent can debug missing data.

### `native-profiler-analyze`

Runs the post-processing pipeline, caches the parsed data on the session (so `profiler-stack-query` can reuse it), and renders the markdown report. Returns `{ report, reportFile, bottlenecksTotal }`. The full report is also written to `<base>-report.md` so the agent can re-read it later without re-analysing.

---

## 5. Pipeline (XML → bottlenecks)

```
parseCpuFile  ─┐
parseHangsFile ┼─► correlateHangsWithCpu ──► uiHangs + hangSampleTimestamps
parseLeaksFile ┘                                                │
                                                                ▼
                                  aggregateCpuHotspots(hangSampleTimestamps)
                                  aggregateLeaks
                                                ──► bottlenecks: CpuHotspot[] | UiHang[] | MemoryLeak[]
```

### Stage 0 — XML parser (`pipeline/xml-parser.ts`)

`xctrace` exports rely on an **id/ref deduplication scheme**: each `<frame>`, `<binary>`, `<backtrace>`, `<thread>`, `<weight>`, `<hang-type>`, etc. is defined once with `id="N"` and referenced afterwards by `<… ref="N"/>`. The parser maintains a `Map` per element type and resolves refs as it goes — without this most rows would be empty.

DOM parsing is impractical (multi-MB files, deep nesting), so the parser pulls only what it needs with targeted regex (`<row[\s>](.*?)</row>`). System frames are flagged here using `SYSTEM_LIBRARY_PATH_PREFIXES` (`/usr/lib/`, `/System/Library/`, `/Library/Developer/CoreSimulator/`) so later stages can cheaply filter them out.

Output shapes:

```ts
CpuSample = { timestampNs, threadFmt, weightNs, stack: StackFrame[] }   // leaf-first
RawHang   = { startNs, durationNs, hangType, threadFmt }
RawLeak   = { objectType, sizeBytes, responsibleFrame, responsibleLibrary, count }
```

### Stage 1 — Correlate (`pipeline/01-correlate.ts`)

- **Hang ↔ CPU correlation.** For each hang, filter CPU samples whose `timestampNs` ∈ `[startNs, startNs + durationNs]`. Within that window, count the **dominant function** of every sample and the **app call chain** (system + hex frames stripped). Top 5 functions and top 3 chains attach to the hang. Their timestamps are also returned in `hangSampleTimestamps` so Stage 2 can flag overlapping CPU hotspots.
- **Leak aggregation.** Group raw leaks by `objectType`, summing `sizeBytes * count`. Sorted by total size descending. (Leaks have no timestamps, so they cannot be correlated with CPU samples — they are reported independently and always RED.)
- Hang severity is classified from the type string: contains `severe` or equals `hang` ⇒ RED; `microhang` ⇒ YELLOW.

### Stage 2 — Aggregate CPU (`pipeline/02-aggregate.ts`)

- **Dominant function detection** (per stack, leaf-first, 3-tier preference):
  1. First non-system, non-hex, non-RN-framework frame (`RN_FRAMEWORK_SIGNATURES` = `RCT`, `Yoga`, `Hermes`, `JSI`, `React`, `facebook::`, `hermes::`, `jsi::`, `HermesRuntime`). This favours user code and third-party SDKs (FullStory, Sentry, Firebase…).
  2. First non-system, non-hex frame (allowing RN internals).
  3. First named frame, else `stack[0]`.
- **Thread normalisation** — fragments like `"main thread"`, `"Main Thread"`, `"com.apple.main-thread"` collapse to `"Main Thread"`; Hermes/JS variants → `"JS/Hermes"`; `"AppName 0x1e4715 (…)"` → `"AppName"`. Without this, hotspots fragment across name variants.
- **Group key** = `dominantFunction + "|||" + normalizedThread`. For each group, accumulate sample count, total weight (ns), timestamps, and per-call-chain frequency.
- **Filter** below `MIN_WEIGHT_PERCENTAGE = 3%` of total trace weight (cuts noise from xctrace's high sample rate).
- **Severity** — > 15 % wall time ⇒ RED; 3 – 15 % ⇒ YELLOW.
- **`duringHang` flag** — true when any timestamp in the group hits a `hangSampleTimestamps` entry.
- **Burst windows** — sort timestamps, split clusters separated by > 500 ms gaps. Each burst is `{ startMs, endMs, sampleCount }`. Helps tell "200 ms once at startup" from "5 ms every 50 ms".

---

## 6. What the report contains

`renderIosProfilerReport` produces a markdown document with these sections:

1. **Header** — trace filename, platform, timestamp, any export warnings.
2. **Summary table** — counts and severity rollup per category (CPU Hotspots / UI Hangs / Memory Leaks).
3. **CPU Hotspots** — table of dominant function, thread, weight (ms / %), sample count, `duringHang` flag, severity. Per hotspot: top 3 call chains and either burst windows or active range.
4. **UI Hangs** — table of type / start (`MM:SS.mmm`) / duration / severity. Per hang: top app call chains during the hang window with sample counts (or top suspected functions if chain extraction was empty).
5. **Memory Leaks** — table of object type, count, total size, responsible frame, library.
6. **Suggested Improvements** — a one-liner per finding with a templated remediation hint.
7. **Next Steps** — concrete `profiler-stack-query` invocations the agent can chain into.

The inline report is capped (top 5 hotspots, top 3 hangs); the full report is always written to `<trace>-report.md` for re-read.

---

## 7. Drill-down: `profiler-stack-query`

Reads the cached `parsedData` on the session — no XML re-parse. Modes:

| Mode               | Inputs                        | What you get                                                                                                                                                                   |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hang_stacks`      | `hang_index`                  | The hang's suspected functions, app call chains during the hang, plus all unique stacks across CPU samples whose dominant function matches a suspect.                          |
| `function_callers` | `function_name`               | Frames immediately above (callers) and below (callees) the named frame across all samples, ranked by frequency. Effectively a poor-man's call graph for a hot native function. |
| `thread_breakdown` | optional `thread` filter      | Per-thread weight (ms/%) and sample count. With a filter, also lists hotspots on that thread.                                                                                  |
| `leak_stacks`      | optional `object_type` filter | Filtered, sorted memory leak table.                                                                                                                                            |

Top-N is configurable (default 15).

---

## 8. Reload past sessions: `profiler-load`

Lists prior `.trace` directories under the debug dir (`<os.tmpdir()>/argent-profiler-cwd/`, e.g. `/var/folders/.../T/argent-profiler-cwd/` on macOS) and re-parses them on demand:

- `mode=list` — enumerate sessions on disk.
- `mode=load_instruments session_id=<ts> device_id=<UDID>` — re-runs the parsing pipeline on the stored XMLs and re-hydrates the session so query tools work again.
- (Also supports `mode=load_react` for Hermes profiler sessions; same idea, different files.)

This is what makes before/after comparisons possible without keeping the original capture session alive.

---

## 9. Cross-tool correlation: `profiler-combined-report`

When both `react-profiler-analyze` and `native-profiler-analyze` ran on the same session, this tool aligns them on a shared **wall-clock anchor**:

- React Profiler stamps `Date.now()` at start and uses `performance.now()` ms internally.
- iOS Instruments uses trace-relative ns starting at 0; the wall-clock anchor is `wallClockStartMs` recorded by `native-profiler-start`.
- Helpers in `utils/profiler-shared/time-align.ts` convert in either direction.

For each iOS hang the tool maps `[hangStart, hangEnd]` → wall-clock and looks for React commits whose `[timestamp, timestamp + totalRenderMs]` overlap (200 ms tolerance for jitter). The output report includes:

- **Hang ↔ Commit correlations** — top overlapping commit per hang with its root-cause component, top components, JS CPU hotspots, and native CPU "suspects".
- **Hangs without React commit match** — likely pure native work.
- **Memory leaks** — heuristically flagged when `objectType` or `responsibleFrame` matches a recently-mounted React component name.

---

## 10. Severity rules at a glance

| Category    | Condition                               | Severity     |
| ----------- | --------------------------------------- | ------------ |
| CPU hotspot | wall-time > 15 %                        | RED          |
| CPU hotspot | wall-time 3 – 15 %                      | YELLOW       |
| CPU hotspot | wall-time < 3 %                         | filtered out |
| UI hang     | type contains `severe` or equals `hang` | RED          |
| UI hang     | `microhang`                             | YELLOW       |
| Memory leak | any                                     | RED          |

> Note: `argent-native-profiler/SKILL.md` currently documents the YELLOW band as 5–15 %. The implementation uses 3–15 % (`MIN_WEIGHT_PERCENTAGE = 3` in `02-aggregate.ts`). The code is the source of truth.

---

## 11. Caveats worth keeping in mind

- **Simulator ≠ device.** Simulator CPU times reflect the host Mac. For absolute numbers, profile a real device.
- **`xctrace` overhead.** Hermes runtime internals (`JSLexer`, `JSONEmitter`, etc.) dominating the JS thread usually means profiler overhead, not app work.
- **Run-to-run variance.** Treat changes < ~15 % across a single run as noise.
- **Live data variance.** Different API responses change rendering work — record a flow (`argent-create-flow`) for stable before/after comparisons.
- **xctrace requirement.** Needs Xcode CLT installed (`xcrun xctrace version`). Some commands (`--hal` for leaks) gate on `xctrace ≥ 15`.

---

## 12. Source map

| Concern                      | File                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Tool definitions             | `tools/profiler/native-profiler/native-profiler-{start,stop,analyze}.ts`      |
| Drill-down query             | `tools/profiler/query/profiler-stack-query.ts`                                |
| Reload past sessions         | `tools/profiler/query/profiler-load.ts`                                       |
| Cross-tool correlation       | `tools/profiler/combined/profiler-combined-report.ts`                         |
| Per-device session state     | `blueprints/native-profiler-session.ts`                                       |
| Bundled template             | `utils/ios-profiler/Argent.tracetemplate`                                     |
| Schema-aware XML export      | `utils/ios-profiler/export.ts`                                                |
| Pipeline (parser + 2 stages) | `utils/ios-profiler/pipeline/{xml-parser,01-correlate,02-aggregate,index}.ts` |
| Markdown rendering           | `utils/ios-profiler/render.ts`                                                |
| RN/system filter signatures  | `utils/ios-profiler/config.ts`                                                |
| Cross-tool time alignment    | `utils/profiler-shared/time-align.ts`                                         |
| Design rationale             | `utils/ios-profiler/PIPELINE_DESIGN.md`                                       |
| User-facing workflow         | `packages/skills/skills/argent-native-profiler/SKILL.md`                      |
