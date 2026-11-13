---
name: argent-native-profiler
description: Native profiling for CPU hotspots, UI hangs, memory issues, and iOS app launch time. iOS via xctrace; Android via Perfetto. Use when diagnosing native-level performance issues.
---

## 1. Tools and platforms

- `native-profiler-start` → `native-profiler-stop` → `native-profiler-analyze`: record, export, and report.
- `profiler-stack-query`: drill into the analyzed data (hang stacks, function callers, thread breakdown, leaks).
- `profiler-load`: reload an earlier session from disk.

**iOS** (Instruments via `xctrace`): the `native-profiler-*` session tools use a simulator only; a physical iPhone is not supported. For app launch time, see §4. Needs full Xcode (`xcrun xctrace version`). Reports CPU hotspots, UI hangs and memory leaks.

**Android** (Perfetto): emulator or physical device. Reports CPU hotspots and UI hangs (with jank reasons and the main thread's blocking function), plus an RSS-growth signal for memory pressure: treat it as a hint to confirm, not a confirmed leak. The app must be debuggable or declare `<profileable android:shell="true"/>` in its manifest, or no `perf_sample` callstacks are captured.

`argent-react-native-profiler` starts native profiling alongside React profiling by default; this skill's workflow and investigation patterns apply in both cases.

## 2. Workflow

**Complete all steps in order; do not break mid-flow.**

1. **Start.** Make sure the app is running (`launch-app` if not); `native-profiler-start` detects it. Pass `app_process` only if it reports several running user apps (e.g. dev and prod flavors) or picks the wrong one. Then let the user interact, or drive the app yourself (`argent-device-interact` skill). While a profiler records, interaction tools return no automatic screenshot or element tree, so the capture does not load the app. Call `screenshot` or `describe` when you need to see the screen; interaction tools still wait for the screen to settle before they return, so add no wait of your own; on an Android emulator each screenshot during a profile takes one frame in about 100 ms and does not wake the screen capture; on a physical Android device it takes about 150–200 ms and briefly wakes the device screen capture, so take them sparingly there.
2. **Stop.** `native-profiler-stop`. On iOS, check `exportDiagnostics` for export warnings.
3. **Analyze.** `native-profiler-analyze`. Findings are 🔴 RED (act on it) or 🟡 YELLOW (worth investigating, may be acceptable).
4. **Present and ask.** Summarize the key findings, then ask the user whether to investigate further, implement fixes, or stop. Do not move on silently.
5. **Drill down** with `profiler-stack-query` (patterns below).
6. **Fix and re-profile** the same scenario; compare with the earlier session via `profiler-load` (`list`, then `load_native` with its `session_id` and the `device_id`). Report honestly whether the target metric improved, regressed, or stayed flat; if there is no net benefit or something else regressed, say so and reconsider. For reproducible before/after runs, record the interaction as an e2e test (`argent-create-e2e` skill) before the first run and replay it with `e2e-execute`.

### Investigation patterns

- **Hang** → mode `hang_stacks` for the native call chain → `function_callers` for the suspected function → read the native source.
- **CPU hotspot** → `thread_breakdown` for the per-thread split → `function_callers` for the dominant function.
- **Memory leak** (iOS) → `leak_stacks`, filtered by `object_type`, for the responsible frames and libraries. To attribute leaks shown as `<Call stack limit reached>`, re-run `native-profiler-start` with `malloc_stack_logging: true`; it restarts the app and adds overhead, so not for CPU or hang passes.

## 3. Caveats

- **Simulator and emulator timings reflect the host machine**, not device hardware. Compare runs against each other rather than trusting absolute numbers; a physical Android device gives real-hardware numbers.
- **Profiler overhead:** if `JSLexer`, `JSONEmitter` or Hermes internals dominate the JS thread, that is instrumentation cost, not app work. Discount those entries.
- **Run-to-run variance:** treat only consistent, directional changes (across 2+ runs, or a >15% delta) as signal.
- **Live data:** if the app fetches live API data, different responses change the workload independently of code changes. Note when data-dependent screens vary.

## 4. App Launch (iOS)

For any iOS app (Swift, Objective-C, React Native, Flutter) when the user asks about launch or startup time.

Use `native-profiler-launch-analysis` with `workspace_path` (the app project root) and `device_id` (the iPhone UDID). `mode` is required:

- `mode: "measure"`: five XCTest launch samples (`averageMs`, `samplesMs`). Use as the baseline and to verify fixes. Do not pass `duration_seconds`; this mode rejects it.
- `mode: "profile"`: Instruments App Launch trace: phases up to the first frame plus a CPU session. Optional `duration_seconds` (5–60, default 8) sets the recording length. Follow `profilerSession.next` (`profiler-load` `load_native` → `profiler-stack-query` `thread_breakdown` with `thread: "Main Thread"`), then `function_callers` for the dominant function. Typical causes: static initializers, dylib loading, heavy `didFinishLaunching` work.
- Both modes build in Release and need a physical iPhone on a USB cable. Use `allow_simulator: true` only when the user accepts Mac-hardware timings. The measured launch is usually warm.
- The launch ends at the first frame. Framework work before it (e.g. React Native runtime creation) appears in the launch profile; work after it belongs to that framework's profiler.
