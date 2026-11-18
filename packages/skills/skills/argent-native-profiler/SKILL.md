---
name: argent-native-profiler
description: Diagnose native CPU hotspots, UI hangs, and memory issues. Use Instruments (xctrace) on iOS simulators and Mac apps, or Perfetto on Android. Use when diagnosing native-level performance issues.
---

## 1. Tools and platforms

- `native-profiler-start` → `native-profiler-stop` → `native-profiler-analyze`: record, export, and report.
- `profiler-stack-query`: drill into the analyzed data (hang stacks, function callers, thread breakdown, leaks).
- `profiler-load`: reload an earlier session from disk.

**iOS** (Instruments via `xctrace`): simulator only; a physical iPhone is not supported. Needs full Xcode (`xcrun xctrace version`). Reports CPU hotspots, UI hangs and memory leaks.

**Android** (Perfetto): emulator or physical device. Reports CPU hotspots and UI hangs (with jank reasons and the main thread's blocking function), plus an RSS-growth signal for memory pressure: treat it as a hint to confirm, not a confirmed leak. The app must be debuggable or declare `<profileable android:shell="true"/>` in its manifest, or no `perf_sample` callstacks are captured.

For **Mac apps** (`platform: "macos"`), use Instruments with full Xcode. If start returns `NATIVE_PROFILER_APP_NOT_DEBUGGABLE`, use a development-signed build. In a background session such as SSH, `template_path: "Time Profiler"` also works for CPU and hangs on a signed build without the debugging entitlement. Do not sign files or add entitlements.

`argent-react-native-profiler` starts native profiling alongside React profiling by default; this skill's workflow and investigation patterns apply in both cases.

## 2. Workflow

**Complete all steps in order; do not break mid-flow.**

1. **Start.** Launch the app through Argent if needed, then call `native-profiler-start`. On iOS and Android, use `app_process` if auto-detection is ambiguous or selects the wrong app. On a Mac, the device ID identifies the app. Then let the user interact, or follow `argent-device-interact` on mobile and `argent-macos-app-interact` on Mac. During recording, use `screenshot` or `describe` when needed because interaction tools omit the automatic screenshot and tree. Actions still wait for the screen to settle. On Android emulators, screenshots capture one frame in about 100 ms. On physical Android devices, they briefly wake screen capture and take about 150–200 ms, so use them sparingly.
2. **Stop.** Keep the app running through `native-profiler-stop`. For Instruments, read `warning` and `exportDiagnostics` before interpreting the report. If the app ended, Instruments stalled, or exports were skipped, repeat the recording when you need the missing data.
3. **Analyze.** `native-profiler-analyze`. Findings are 🔴 RED (act on it) or 🟡 YELLOW (worth investigating, may be acceptable).
4. **Present and ask.** Summarize the key findings, then ask the user whether to investigate further, implement fixes, or stop. Do not move on silently.
5. **Drill down** with `profiler-stack-query` (patterns below).
6. **Fix and re-profile** the same scenario; compare with the earlier session via `profiler-load` (`list`, then `load_native` with its `session_id` and the `device_id`). Report honestly whether the target metric improved, regressed, or stayed flat; if there is no net benefit or something else regressed, say so and reconsider. For reproducible before/after runs, record the interaction as an e2e test (`argent-create-e2e` skill) before the first run and replay it with `e2e-execute`.

### Investigation patterns

- **Hang** → mode `hang_stacks` for the native call chain → `function_callers` for the suspected function → read the native source. If a Mac hang overlaps a leak-check pause, repeat the scenario with `template_path: "Time Profiler"` to measure the hang without leak checks.
- **CPU hotspot** → `thread_breakdown` for the per-thread split → `function_callers` for the dominant function.
- **Memory leak** (iOS simulator or Mac app). Keep recording about 25 seconds after the suspected leak so Instruments has time to finish a check. If the report warns that the capture was too short, repeat the recording before drawing conclusions about leaks. Use `leak_stacks` with `object_type` to find allocation stacks. For missing stacks such as `<Call stack limit reached>`, save any needed app state and use `malloc_stack_logging: true` on a separate leak pass. On Mac, reserve it for allocations that predate recording and use `restart-app` to clear the overhead before measuring CPU or hangs.

## 3. Caveats

- **Simulator and emulator timings reflect the host machine**, not device hardware. Compare runs against each other rather than trusting absolute numbers; a physical Android device gives real-hardware numbers.
- **Profiler overhead:** if `JSLexer`, `JSONEmitter` or Hermes internals dominate the JS thread, that is instrumentation cost, not app work. Discount those entries.
- **Run-to-run variance:** treat only consistent, directional changes (across 2+ runs, or a >15% delta) as signal.
- **Live data:** if the app fetches live API data, different responses change the workload independently of code changes. Note when data-dependent screens vary.
