---
name: react-native-profiler
description: Profile a React Native Hermes app to measure re-render and CPU performance using argent profiler tools. Use during optimization to measure before/after, spot slow components, diagnose re-renders, check CPU hotspots, or produce a ranked issue report.
---

## 1. Prerequisites

All profiling goes through argent MCP tools. This workflow requires executing tools on the device.

**This skill is complementary to `react-native-optimization`, not a replacement for it.** 

## 2. Tool Overview

### React Profiler (Hermes / React commits)

| Tool                              | Purpose                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `react-profiler-start`            | Start CPU sampling + inject React commit-capture hook. Auto-connects to Metro.           |
| `react-profiler-stop`             | Stop recording; stores cpuProfile + commitTree in session.                               |
| `react-profiler-analyze`          | Run pipeline -> report with CPU-enriched hot commits and findings sorted by `totalRenderMs` DESC. Saves raw data to disk for later reload. |
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
| `profiler-load`            | List and reload previous profiling sessions from disk for re-investigation with query tools.       |

For native iOS profiling (CPU hotspots, UI hangs, memory leaks), see the `ios-profiler` skill.

---

## 3. Agent Behavior Guidelines

Follow these rules throughout the profiling workflow:

### Before profiling: always start both in parallel

Always call `react-profiler-start` and `ios-profiler-start` in a single parallel message. Announce this: _"Starting React + native iOS profiling in parallel — JS commits plus native CPU/hangs/leaks."_ Do NOT ask first. Only skip `ios-profiler-start` if the user has **already explicitly said** they don't want native profiling in this session.

- Start `react-profiler-start` and `ios-profiler-start` in parallel (two tool calls in one message).
- If the user only wants iOS-only, use the `ios-profiler` skill workflow.

### After analysis: ask about next steps

After presenting the analysis report, always ask the user what they want to do next. Present these options:

1. **Investigate further** — drill down into specific findings using query tools (CPU call trees, commit cascades, hang stacks, etc.) to identify root causes with confidence before making changes.
2. **Implement fixes** — apply changes based on the current findings, then re-profile to measure improvement.
3. **Done for now** — accept the report as-is.

Do NOT silently move on after the report. The report is the starting point, not the end — query tools exist specifically to let you dig deeper into anything the report flags.

### During investigation: use query tools proactively

When drilling down, chain query tool calls based on what you find:

- A hot commit -> `profiler-commit-query` mode=`by_index` to see all components -> `profiler-cpu-query` mode=`component_cpu` for the slowest one -> `profiler-cpu-query` mode=`call_tree` for the hot function -> read the source file -> propose a fix.
- A memory leak -> `profiler-stack-query` mode=`leak_stacks` to identify the responsible module -> read the native source if actionable.
- An iOS hang -> `profiler-stack-query` mode=`hang_stacks` to get the native call chain -> correlate with React commit timing.

### After fixes: always re-profile

When you apply a fix, always re-profile the same scenario afterward to confirm improvement. Compare the before/after metrics (commit durations, CPU time, render counts). If you need to reference the original data, use `profiler-load` to reload the pre-fix session.

---

## 4. Standard Profiling Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 1: Choose profiling scope

Follow the "Before profiling" guideline above. Default is dual profiling — start both in parallel.

### Step 2: Start profiling

Call `react-profiler-start` **and** `ios-profiler-start` in parallel (two tool calls in one message). Do NOT ask — dual profiling is the default. Only skip `ios-profiler-start` if the user already explicitly opted out in this session. **Save `startedAtEpochMs` from the response** — you will need it later to compute annotation offsets. On success:
- if user asked you to perform the profiling, determine how to profile yourself using tools described in `simulator-interact` skill.
- if the user stated they wish to perform the interaction themselves — suggest what interaction to perform (e.g. "scroll the list", "switch tabs") and wait for their reply.

### Annotate every interaction

After each `tap` or `swipe` call, record an annotation using the returned `timestampMs`. Compute `offsetMs = timestampMs - startedAtEpochMs`. Do this for *every* interaction — including back-navigation swipes, not just the primary action. Pass all collected annotations to `react-profiler-analyze` in Step 4.

### Step 3: Stop and collect

Call `react-profiler-stop` **and** `ios-profiler-stop` in parallel. Only skip `ios-profiler-stop` if you did not start it in Step 2. Note `duration_ms`, `fiber_renders_captured`, `hook_installed`.
If `hook_installed: false` or `fiber_renders_captured: 0`, warn the user — React commit data may be missing.

### Step 4: Analyze

Call `react-profiler-analyze` with `project_root`, `platform`, and `rn_version`. Read `meta` first: note `reactCompilerEnabled`, `strictModeEnabled`, `buildMode`.

If you performed interactions using `tap`/`swipe`, pass `annotations` to mark when each action occurred. Each annotation's `offsetMs` must be computed as `tapTimestampMs - startedAtEpochMs`, where `tapTimestampMs` is the `timestampMs` returned by the tap/swipe tool and `startedAtEpochMs` was returned by `react-profiler-start`. Do **not** use `Date.now()` for this calculation — only server-side timestamps from the tool return values.

If dual profiling, also call `ios-profiler-analyze`, then call `profiler-combined-report` for the cross-correlated view.

The analyze report includes **CPU hotspots per commit** — showing exactly which JS functions ran during each slow React commit. Raw data is saved to disk automatically for later reload.

### Step 5: Present findings and ask about next steps

Present a concise summary of the key findings. Then follow the "After analysis" guideline — ask whether to investigate further, implement fixes, or stop.

### Step 6: Drill-down investigation (iterative)

Based on findings from the report, use query tools to investigate deeper:

- **Slow component?** -> `profiler-cpu-query` mode=`component_cpu` component_name=`AppNavigator` — shows what JS functions ran during that component's commits.
- **Want to see the call tree?** -> `profiler-cpu-query` mode=`call_tree` function_name=`expensiveFunction` — shows callers and callees.
- **What happened during a time window?** -> `profiler-commit-query` mode=`by_time_range` — lists all commits in a range.
- **Full commit detail?** -> `profiler-commit-query` mode=`by_index` commit_index=38 — all components, props changes, parent cascade.
- **Who triggered whom?** -> `profiler-commit-query` mode=`cascade_tree` — visual parent-child cascade.
- **iOS hang details?** -> `profiler-stack-query` mode=`hang_stacks` — native call stacks during a hang.

Repeat as needed until you identify the root cause function and file. After each round of investigation, ask the user if they want to continue digging or move to fixing.

### Step 7: Reload a previous session

If you profiled multiple scenarios and need to revisit earlier data:

1. Call `profiler-load` mode=`list` to see all saved sessions with timestamps.
2. Call `profiler-load` mode=`load_react` session_id=`<timestamp>` to reload React data.
3. Call `profiler-load` mode=`load_instruments` session_id=`<timestamp>` device_id=`<UDID>` to reload iOS data.
4. Query tools now operate on the reloaded session data.

This is useful for before/after comparisons: profile, fix, re-profile, then reload the original session to compare metrics side by side.

### Step 8: Apply fix and re-profile

Read the source code of the identified bottleneck using `react-profiler-component-source` or the Read tool. Apply the fix, then re-profile (Step 2 -> user interaction -> Step 3 -> Step 4) to confirm improvement.

If the user stated that he does not wish for changes, present the profiling report and skip the fix but suggest it to the user.

**React Compiler rule:** If `meta.reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out (check `react-profiler-fiber-tree` for absent `useMemoCache` on that component).

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
| List/reload previous sessions            | `profiler-load`                   |

## Related Skills

| Skill                       | When to use                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `react-native-optimization` | Choose and apply the right fix for profiler findings          |
| `simulator-interact`        | Test the app live by interacting with it in the simulator     |
| `ios-profiler`              | Native iOS profiling for CPU hotspots, UI hangs, memory leaks |
| `react-native-app-workflow` | Starting the app, Metro setup, build issues                   |
| `metro-debugger`            | Breakpoints, stepping, console logs, JS evaluation            |
| `simulator-setup`           | Booting and connecting a simulator                            |
| `simulator-screenshot`      | Capturing the simulator screen                                |
| `test-ui-flow`              | Interactive UI testing with screenshot verification           |
