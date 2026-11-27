---
name: argent-native-profiler
description: Profile native CPU hotspots, UI hangs, memory, and iOS launch time via Instruments (iOS/Mac) or Perfetto (Android). Use when diagnosing native performance issues.
---

## 1. Tools and platforms

- `native-profiler-start` → `native-profiler-stop` → `native-profiler-analyze`: record, export, and report.
- `profiler-stack-query`: drill into the analyzed data (hang stacks, function callers, thread breakdown, leaks).
- `profiler-load`: reload an earlier session from disk.

**iOS** (Instruments via `xctrace`): the profiling session (`native-profiler-start`) runs on a simulator only; `native-profiler-launch-analysis` (§4) also runs on a physical iPhone. Needs full Xcode (`xcrun xctrace version`). Reports CPU hotspots, UI hangs and memory leaks.

**Android** (Perfetto): emulator or physical device. Reports CPU hotspots and UI hangs (with jank reasons and the main thread's blocking function), plus an RSS-growth signal for memory pressure: treat it as a hint to confirm, not a confirmed leak. The app must be debuggable or declare `<profileable android:shell="true"/>` in its manifest, or no `perf_sample` callstacks are captured.

For **Mac apps** (`platform: "macos"`), use Instruments with full Xcode. If start returns `NATIVE_PROFILER_APP_NOT_DEBUGGABLE`, use a development-signed build. In a background session such as SSH, `template_path: "Time Profiler"` also works for CPU and hangs on a signed build without the debugging entitlement. Do not sign files or add entitlements.

If `native-profiler-start` returns `NATIVE_PROFILER_APP_HAS_WEBKIT_HEAP` or `NATIVE_PROFILER_APP_HEAP_CHECK_FAILED` on a Mac app, choose the retry based on what you need to measure.

- For CPU and hangs, use `template_path: "Time Profiler"` to keep the app running in its current state.
- For leaks, use the bundled template with `malloc_stack_logging: true`, even for allocations made during the recording. Save any state you need before retrying because this restarts the app.

While logging is off, avoid `Leaks`, `Allocations`, and other templates that use the Allocations instrument on these apps. They can freeze the app.

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

## 4. App Launch (iOS)

For any iOS app (Swift, Objective-C, React Native, Flutter) when the user asks about launch or startup time.

1. Build a Release build and install it yourself with the project's own scripts or build setup (for React Native, find them as `argent-react-native-app-workflow` describes); the tool only measures an installed build. Debug-build timings are not meaningful.
2. Target a physical iPhone on USB. Ask the user before you use a booted simulator: its timings reflect the Mac hardware.
3. Run `native-profiler-launch-analysis`: `mode: "measure"` for the baseline and to verify fixes, `mode: "profile"` to find the cause of a slow launch. On an iPhone, `measure` runs on Argent's on-device runner (see `argent-ios-device-setup`); `profile` does not need it. If the runner cannot be signed, tell the user how to fix it. A profile still shows the cause, but it does not replace the five-launch baseline.
4. For a profile, load its session with `profiler-load` `load_native`, then run `profiler-stack-query` `thread_breakdown` on the main thread, then `function_callers` for the dominant function. Typical causes: static initializers, dylib loading, heavy `didFinishLaunching` work.
5. Rebuild and reinstall the Release build after each native or JS change, before you measure again.

`native-profiler-launch-analysis` ends at the first frame. Framework work before it (e.g. React Native runtime creation) appears in the launch profile. Work after it (e.g. a JS bundle, startup data loading, the first screen's render) is not in the result, and the first frame is often only a splash screen. For the time until the app is usable, investigate that work separately; for React Native, see Startup time in `argent-react-native-optimization`.
