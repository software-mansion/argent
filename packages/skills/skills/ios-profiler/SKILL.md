---
name: ios-profiler
description: Native iOS profiling for CPU hotspots, UI hangs, and memory leaks via xctrace. Use when diagnosing native-level performance issues on iOS simulators or devices.
---

## 1. Prerequisites

- A booted iOS simulator (see `simulator-setup` skill) or connected device.
- Argent MCP tools available. This workflow requires executing tools on the device — if in plan mode, ask the user to exit first.

## 2. Tool Overview

| Tool                   | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `ios-profiler-start`   | Start xctrace recording on a booted simulator or device. Captures CPU, hangs, and leaks.     |
| `ios-profiler-stop`    | Stop xctrace, export trace data to XML files (timestamped, persist on disk).                 |
| `ios-profiler-analyze` | Parse exported XML and return structured bottleneck payload (CPU hotspots, UI hangs, leaks). |
| `profiler-stack-query` | Drill into parsed data: hang stacks, function callers, thread breakdown, leak details.       |
| `profiler-load`        | List and reload previous trace sessions from disk for re-investigation.                      |

---

## 3. Agent Behavior Guidelines

### Before profiling: always start both in parallel

Always start `ios-profiler-start` and `react-profiler-start` in a single parallel message, announcing it upfront: _"Starting React + native iOS profiling in parallel — JS commits plus native CPU/hangs/leaks."_ Do NOT ask first. Only skip `react-profiler-start` if the user has **already explicitly said** they don't want React profiling in this session.

- Start both tools in parallel (two tool calls in one message), stop both, analyze both, then call `profiler-combined-report` for the cross-correlated view.
- If the user only wants native profiling, follow the standalone workflow below.

### After analysis: ask about next steps

After presenting the iOS Instruments report, always ask the user:

1. **Investigate further** — use `profiler-stack-query` to drill into specific hangs, CPU hotspots, or leaks. Identify exact native call chains and responsible modules.
2. **Implement fixes** — apply changes and re-profile to confirm improvement.
3. **Done for now** — accept the report as-is.

Do NOT silently move on. The initial report surfaces what is slow — query tools reveal why.

### During investigation: chain queries

- Hang detected -> `profiler-stack-query` mode=`hang_stacks` to see full native call chains -> `profiler-stack-query` mode=`function_callers` for the suspected function -> read native source.
- CPU hotspot -> `profiler-stack-query` mode=`thread_breakdown` to see per-thread distribution -> `function_callers` for the dominant function.
- Memory leak -> `profiler-stack-query` mode=`leak_stacks` filtered by `object_type` to see responsible frames and libraries.

### After fixes: always re-profile

Re-run the same scenario after applying fixes. Use `profiler-load` to reload the pre-fix session and compare before/after metrics.

---

## 4. Standalone Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 0: Ensure the target app is running

The `ios-profiler-start` tool **auto-detects** the running app on the simulator.
You do not need to derive `app_process` manually — just make sure the app is launched.

1. If the app is already running on the simulator, skip to Step 1 (do not pass `app_process`).
2. If the app is not running, use `launch-app` with the correct bundle ID first.
3. Only pass `app_process` explicitly if the tool reports multiple running user apps and you need to disambiguate.

> **Note**: If multiple build flavors are installed (dev, staging, prod), the tool will detect whichever one is currently running. If both are running, it will ask you to specify.

### Step 1: Start recording

Call `ios-profiler-start` with `device_id` (simulator UDID) and `project_root` (absolute path to the user's project root). The tool auto-detects the running app and saves the trace to `<project_root>/argent-profiler-cwd/` with a timestamped filename.
Let the user interact with the app or drive interaction via simulator tools (see `simulator-interact` skill).

### Step 2: Stop and export

Call `ios-profiler-stop` with `device_id`. This sends SIGINT to xctrace, waits for trace packaging, and exports CPU, hangs, and leaks data to XML. Check `exportDiagnostics` in the response for any export warnings.

### Step 3: Analyze

Call `ios-profiler-analyze` with `device_id`. Returns a markdown report with bottlenecks categorized as CPU hotspots, UI hangs, or memory leaks, sorted by severity.

### Step 4: Present findings and ask about next steps

Present a concise summary of the key findings. Then follow the "After analysis" guideline — ask whether to investigate further with query tools, implement fixes, or stop.

### Step 5: Drill-down investigation

Use `profiler-stack-query` to investigate specific findings. See Section 3 for chaining guidance.

### Step 6: Reload previous sessions

To revisit a previous trace:

1. Call `profiler-load` mode=`list` project_root=`<path>` to see available sessions.
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

---

## Quick Reference

| Action                          | Tool                   |
| ------------------------------- | ---------------------- |
| Start iOS Instruments recording | `ios-profiler-start`   |
| Stop iOS Instruments            | `ios-profiler-stop`    |
| Analyze iOS Instruments trace   | `ios-profiler-analyze` |
| Drill into hangs/CPU/leaks      | `profiler-stack-query` |
| Reload previous trace session   | `profiler-load`        |

## Related Skills

| Skill                        | When to use                                               |
| ---------------------------- | --------------------------------------------------------- |
| `react-native-optimization`  | Entry-point for all performance work — choose and apply fixes for profiler findings |
| `react-native-profiler`      | React/Hermes profiling for re-renders and JS CPU hotspots |
| `simulator-setup`            | Booting and connecting a simulator                        |
| `simulator-interact`         | Driving UI interaction on the simulator                   |
