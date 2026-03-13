---
name: react-native-profiler
description: Profile a React Native Hermes app to find re-render and CPU performance issues using argent profiler tools. Use when profiling performance, finding slow components, diagnosing re-renders, checking CPU hotspots, or producing a ranked issue report with source-level fixes.
---

## 1. Prerequisites

All profiling goes through argent MCP tools. This workflow requires executing tools on the device — if in plan mode, ask the user to exit first.

## 2. Tool Overview

### React Profiler (Hermes / React commits)

| Tool                              | Purpose                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `react-profiler-start`            | Start CPU sampling + inject React commit-capture hook. Auto-connects to Metro.           |
| `react-profiler-stop`             | Stop recording; stores cpuProfile + commitTree in session.                               |
| `react-profiler-analyze`          | Run pipeline → report with CPU-enriched hot commits and findings sorted by `totalRenderMs` DESC. |
| `react-profiler-component-source` | AST lookup: file, line, memoization status, 50 lines of source for a component.          |
| `react-profiler-renders`          | Live fiber walk: render counts + durations per component (no profiling session required). |
| `react-profiler-fiber-tree`       | Live fiber walk: full component hierarchy as JSON.                                       |

### Drill-Down Query Tools (call after analyze)

| Tool                       | Purpose                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `profiler-cpu-query`       | Targeted CPU investigation: top functions, time-windowed CPU, call trees, per-component CPU.      |
| `profiler-commit-query`    | Targeted commit investigation: by component, time range, commit index, or cascade tree.           |
| `profiler-stack-query`     | iOS Instruments drill-down: hang stacks, function callers, thread breakdown, leak details.         |
| `profiler-combined-report` | Cross-correlated report when both React Profiler and iOS Instruments ran in parallel.              |

For native iOS profiling (CPU hotspots, UI hangs, memory leaks), see the `ios-instruments` skill.

---

## 3. Standard React Profiler Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 1: Choose profiling scope

Ask the user: _"Do you want to profile just React/JS, or native iOS as well?"_
- **React only:** proceed with `react-profiler-start` only.
- **React + native:** start both `react-profiler-start` and `ios-instruments-start` in parallel (two tool calls in one message).

### Step 2: Start profiling

Call `react-profiler-start` (and `ios-instruments-start` if dual profiling). On success:
- if user asked you to perform the profiling, determine how to profile yourself using tools described in `simulator-interact` skill.
- if the user stated he wishes to profile himself - suggest what interaction to perform — e.g. _"Please scroll the list / switch tabs. Tell me when done."_ Wait for their reply.

### Step 3: Stop and collect

Call `react-profiler-stop` (and `ios-instruments-stop` if dual). Note `duration_ms`, `fiber_renders_captured`, `hook_installed`.
If `hook_installed: false` or `fiber_renders_captured: 0`, warn the user — React commit data may be missing.

### Step 4: Analyze

Call `react-profiler-analyze` with `project_root`, `platform`, and `rn_version`. Read `meta` first: note `reactCompilerEnabled`, `strictModeEnabled`, `buildMode`.

If dual profiling, also call `ios-instruments-analyze`, then call `profiler-combined-report` for the cross-correlated view.

The analyze report now includes **CPU hotspots per commit** — showing exactly which JS functions ran during each slow React commit.

### Step 5: Drill-down investigation (iterative)

Based on findings from the report, use query tools to investigate deeper:

- **Slow component?** → `profiler-cpu-query` mode=`component_cpu` component_name=`AppNavigator` — shows what JS functions ran during that component's commits.
- **Want to see the call tree?** → `profiler-cpu-query` mode=`call_tree` function_name=`expensiveFunction` — shows callers and callees.
- **What happened during a time window?** → `profiler-commit-query` mode=`by_time_range` — lists all commits in a range.
- **Full commit detail?** → `profiler-commit-query` mode=`by_index` commit_index=38 — all components, props changes, parent cascade.
- **Who triggered whom?** → `profiler-commit-query` mode=`cascade_tree` — visual parent-child cascade.
- **iOS hang details?** → `profiler-stack-query` mode=`hang_stacks` — native call stacks during a hang.

Repeat as needed until you identify the root cause function and file.

### Step 6: Apply fix and re-profile

Read the source code of the identified bottleneck using `react-profiler-component-source` or the Read tool. Apply the fix, then re-profile (Step 2 → user interaction → Step 3 → Step 4) to confirm improvement.

If the user stated that he does not wish for changes, present the profiling report and skip the fix but suggest it to the user.

**React Compiler rule:** If `meta.reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out (check `react-profiler-fiber-tree` for absent `useMemoCache` on that component).

---

## 4. Choosing the Right Profiler

This skill covers **React/Hermes profiling** — re-renders, slow commits, and JS-level CPU hotspots. For **native iOS profiling** (CPU time profile hotspots, UI hang detection, memory leaks), use the `ios-instruments` skill. Both can run in parallel on the same simulator.

---

## 5. Important Caveats

- **Dev mode inflation**: `buildMode: "dev"` renders are ~3x slower than production. Prioritize high `normalizedRenderCount` — it scales to prod.
- **Re-run after fixes**: Always re-profile to confirm `totalRenderMs` dropped.
- **`excluded` is informational**: Components in `animatedSubtrees` and `recyclerChildren` re-render by design.
- **Strict Mode**: Double-invokes renders. The pipeline halves `normalizedRenderCount` automatically when detected.
- **Debugger connection**: If interrupted, started profiling also closes. Check debugger status and restart the flow on errors.

For standalone diagnostic tools (live render stats, fiber tree, CPU summary), see `references/diagnostic-tools.md`.

---

## Quick Reference

| Action                                   | Tool                              |
| ---------------------------------------- | --------------------------------- |
| Start React profiling session            | `react-profiler-start`            |
| Stop and collect React data              | `react-profiler-stop`             |
| Full React analysis with report          | `react-profiler-analyze`          |
| Look up component source                 | `react-profiler-component-source` |
| Live render counts (no session)          | `react-profiler-renders`          |
| Component hierarchy                      | `react-profiler-fiber-tree`       |
| Drill into CPU by component/function     | `profiler-cpu-query`              |
| Drill into commit data                   | `profiler-commit-query`           |
| Drill into native stacks/hangs/leaks     | `profiler-stack-query`            |
| Cross-correlated React + iOS report      | `profiler-combined-report`        |

## Related Skills

| Skill                       | When to use                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `ios-instruments`           | Native iOS profiling for CPU hotspots, UI hangs, memory leaks |
| `react-native-app-workflow` | Starting the app, Metro setup, build issues                   |
| `metro-debugger`            | Breakpoints, stepping, console logs, JS evaluation            |
| `simulator-setup`           | Booting and connecting a simulator                            |
| `simulator-screenshot`      | Capturing the simulator screen                                |
| `test-ui-flow`              | Interactive UI testing with screenshot verification           |
