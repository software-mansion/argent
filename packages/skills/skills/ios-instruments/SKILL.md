---
name: ios-instruments
description: Native iOS profiling for CPU hotspots, UI hangs, and memory leaks via xctrace. Use when diagnosing native-level performance issues on iOS simulators or devices.
---

## 1. Prerequisites

- A booted iOS simulator (see `simulator-setup` skill) or connected device.
- Argent MCP tools available. This workflow requires executing tools on the device — if in plan mode, ask the user to exit first.

## 2. Tool Overview

| Tool                      | Purpose                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `ios-instruments-start`   | Start xctrace recording on a booted simulator or device. Captures CPU, hangs, and leaks.    |
| `ios-instruments-stop`    | Stop xctrace, export trace data to XML files.                                               |
| `ios-instruments-analyze` | Parse exported XML and return structured bottleneck payload (CPU hotspots, UI hangs, leaks). |

---

## 3. Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 0: Ensure the target app is running

The `ios-instruments-start` tool **auto-detects** the running app on the simulator.
You do not need to derive `app_process` manually — just make sure the app is launched.

1. If the app is already running on the simulator, skip to Step 1 (do not pass `app_process`).
2. If the app is not running, use `launch-app` with the correct bundle ID first.
3. Only pass `app_process` explicitly if the tool reports multiple running user apps and you need to disambiguate.

> **Note**: If multiple build flavors are installed (dev, staging, prod), the tool will detect whichever one is currently running. If both are running, it will ask you to specify.

### Step 1: Start recording

Call `ios-instruments-start` with `device_id` (simulator UDID) and `project_root` (absolute path to the user's project root). The tool auto-detects the running app and saves the trace to `<project_root>/rn-devtools-debug/` with a timestamped filename.
Let the user interact with the app or drive interaction via simulator tools (see `simulator-interact` skill).

### Step 2: Stop and export

Call `ios-instruments-stop` with `device_id`. This sends SIGINT to xctrace, waits for trace packaging, and exports CPU, hangs, and leaks data to XML.

### Step 3: Analyze

Call `ios-instruments-analyze` with `device_id`. Returns a markdown report with bottlenecks categorized as CPU hotspots, UI hangs, or memory leaks, sorted by severity.

---

## 4. Understanding Results

Bottlenecks are categorized by severity:

- **RED**: CPU functions taking >15% of total time, all UI hangs, all memory leaks. These require immediate attention.
- **YELLOW**: CPU functions taking 5–15% of total time. Worth investigating but may be acceptable.

Each bottleneck type indicates a different class of problem:

- **CPU hotspots**: Native functions consuming excessive CPU time. Look for tight loops, expensive computations, or redundant work.
- **UI hangs**: Main thread blocked long enough to cause visible jank or unresponsiveness. Often caused by synchronous I/O, heavy layout passes, or lock contention.
- **Memory leaks**: Objects allocated but never freed. Common causes include retain cycles, unclosed resources, or forgotten observers.

---

## 5. Important Caveats

- **Simulator vs device**: Simulator profiling reflects host Mac performance, not real device hardware. Use device profiling for accurate CPU timings and memory behavior.
- **xctrace availability**: Requires Xcode command-line tools installed. Verify with `xcrun xctrace version`.

---

## Quick Reference

| Action                          | Tool                      |
| ------------------------------- | ------------------------- |
| Start iOS Instruments recording | `ios-instruments-start`   |
| Stop iOS Instruments            | `ios-instruments-stop`    |
| Analyze iOS Instruments trace   | `ios-instruments-analyze` |

## Related Skills

| Skill                     | When to use                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `react-native-profiler`   | React/Hermes profiling for re-renders and JS CPU hotspots   |
| `simulator-setup`         | Booting and connecting a simulator                          |
| `simulator-interact`      | Driving UI interaction on the simulator                     |
