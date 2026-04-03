---
name: argent-ios-profiler
description: Native iOS profiling for CPU hotspots, UI hangs, and memory leaks via xctrace. Use when diagnosing native-level performance issues on iOS simulators or devices.
---

## 1. Tool Overview

| Tool                   | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `ios-profiler-start`   | Start xctrace recording on a booted simulator or device. Captures CPU, hangs, and leaks.     |
| `ios-profiler-stop`    | Stop xctrace, export trace data to XML files (timestamped, persist on disk).                 |
| `ios-profiler-analyze` | Parse exported XML and return structured bottleneck payload (CPU hotspots, UI hangs, leaks). |
| `profiler-stack-query` | Drill into parsed data: hang stacks, function callers, thread breakdown, leak details.       |
| `profiler-load`        | List and reload previous trace sessions from disk for re-investigation.                      |

---

## 2. Investigation Patterns

After `ios-profiler-analyze` surfaces findings, use `profiler-stack-query` to drill into root causes:

- **Hang detected** → `profiler-stack-query` mode=`hang_stacks` for full native call chains → mode=`function_callers` for the suspected function → read native source.
- **CPU hotspot** → `profiler-stack-query` mode=`thread_breakdown` for per-thread distribution → mode=`function_callers` for the dominant function.
- **Memory leak** → `profiler-stack-query` mode=`leak_stacks` filtered by `object_type` for responsible frames and libraries.

After presenting findings, ask the user whether to investigate further, implement fixes, or stop. After applying fixes, always re-profile the same scenario and compare with `profiler-load`. Report honestly whether the target metric improved, regressed, or stayed flat. If the fix showed no net benefit or introduced regressions elsewhere, say so and reconsider.

**Tip:** For reproducible before/after comparisons, record the interaction sequence as a flow using the `argent-create-flow` skill before the first profiling run. Replay with `flow-execute` on subsequent runs to eliminate interaction variance.

> **Note:** The `argent-react-native-profiler` instructs to start iOS profiling automatically alongside React profiling. This skill's workflow and investigation patterns apply in both cases.

---

## 4. Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 0: Choose device and ensure the target app is running

**Simulator vs physical device:** Call `list-devices` to find a target device.

- **Prefer simulators** for fast iteration, CI, and most development workflows.
- **Use a physical device** (`include_physical_devices: true`) when the user explicitly asks for device profiling, or when you need accurate real-world data: CPU/GPU timings, thermal throttling, real memory behavior, or hardware-dependent features (camera, GPS, NFC, push notifications).

> Physical devices do **not** support automated interaction (taps, swipes, screenshots, describe) — only profiling and debugging tools work. The user must navigate the device by hand.

The `ios-profiler-start` tool **auto-detects** the running app on the simulator or device.
You do not need to derive `app_process` manually — just make sure the app is launched.

1. If the app is already running, skip to Step 1 (do not pass `app_process`).
2. If the app is not running on a simulator, use `launch-app` with the correct bundle ID first. On a physical device, ask the user to launch the app.
3. Only pass `app_process` explicitly if the tool reports multiple running user apps and you need to disambiguate.

> **Note**: If multiple build flavors are installed (dev, staging, prod), the tool will detect whichever one is currently running. If both are running, it will ask you to specify.

### Step 1: Start recording

Call `ios-profiler-start` with `device_id` (simulator UDID). The tool auto-detects the running app and saves the trace to `/tmp/argent-profiler-cwd/` with a timestamped filename.
Let the user interact with the app or drive interaction via simulator tools (see `argent-simulator-interact` skill).

### Step 2: Stop and export

Call `ios-profiler-stop` with `device_id`. This sends SIGINT to xctrace, waits for trace packaging, and exports CPU, hangs, and leaks data to XML. Check `exportDiagnostics` in the response for any export warnings.

### Step 3: Analyze

Call `ios-profiler-analyze` with `device_id`. Returns a markdown report with bottlenecks categorized as CPU hotspots, UI hangs, or memory leaks, sorted by severity.

### Step 4: Present findings and ask about next steps

Present a concise summary of the key findings. Then follow the "After analysis" guideline — ask whether to investigate further with query tools, implement fixes, or stop.

### Step 5: Drill-down investigation

Use `profiler-stack-query` to investigate specific findings. See §3 Investigation Patterns for chaining guidance.

### Step 6: Reload previous sessions

To revisit a previous trace:

1. Call `profiler-load` mode=`list` to see available sessions.
2. Call `profiler-load` mode=`load_instruments` session_id=`<timestamp>` device_id=`<UDID>` to re-parse the XML files.
3. Use `profiler-stack-query` to investigate the reloaded data.

---

## 5. Understanding Results

Bottlenecks are categorized by severity:

- **RED**: CPU functions taking >15% of total time, all UI hangs, all memory leaks. These require immediate attention.
- **YELLOW**: CPU functions taking 5-15% of total time. Worth investigating but may be acceptable.

Each bottleneck type indicates a different class of problem:

- **CPU hotspots**: Native functions consuming excessive CPU time. Look for tight loops, expensive computations, or redundant work.
- **UI hangs**: Main thread blocked long enough to cause visible jank or unresponsiveness. Often caused by synchronous I/O, heavy layout passes, or lock contention.
- **Memory leaks**: Objects allocated but never freed. Common causes include retain cycles, unclosed resources, or forgotten observers.

---

## 6. Important Caveats

- **Simulator vs device**: Simulator profiling reflects host Mac performance, not real device hardware. Use device profiling for accurate CPU timings and memory behavior.
- **xctrace availability**: Requires Xcode command-line tools installed. Verify with `xcrun xctrace version`.
- **Profiler overhead**: xctrace instrumentation adds CPU load. If `JSLexer`, `JSONEmitter`, or Hermes runtime internals dominate the JS thread in CPU hotspot results, those reflect profiler overhead — not app work. Discount those entries when evaluating findings.
- **Run-to-run variance**: Small fluctuations in CPU percentages between runs are normal. Treat only consistent directional changes (across 2+ runs or >15% delta) as actionable signal.
- **Live data variability**: If the app fetches live API data, different responses between runs change rendering workload independently of code changes. Note when data-dependent screens show variance.

---
