---
name: rn-profiler
description: Profile a React Native app on Hermes to identify re-render performance issues. Use when profiling performance, finding slow components, diagnosing re-renders, checking CPU hotspots, or producing a ranked issue report with source-level fixes.
---

# React Native Profiler

Profile a React Native app running on Hermes to identify re-render performance issues.
Produces an `IssueReport` with ranked findings, CPU hotspots, and actionable source-level fixes.

## Prerequisites

**Plan mode check:** This workflow requires executing tools on the device. If you are currently in plan mode, inform the user that profiling cannot run in plan mode and ask them to exit plan mode first (e.g. "Profiling requires running tools on the simulator — please exit plan mode so I can start the session."). Do not attempt to call any profiler tools while in plan mode.

## Tool Overview

| Tool                                         | Purpose                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mcp__argent__profiler-start`            | Start CPU sampling + inject React commit-capture hook. Auto-connects to Metro if needed.  |
| `mcp__argent__profiler-stop`             | Stop recording; stores `cpuProfile` + `commitTree` in session.                            |
| `mcp__argent__profiler-analyze`          | Run 5-stage pipeline → `IssueReport` with `findings[]` sorted by `totalRenderMs` DESC.    |
| `mcp__argent__profiler-component-source` | AST lookup: file, line, memoization status, 50 lines of source for a component.           |
| `mcp__argent__profiler-cpu-summary`      | Quick CPU hotspot markdown table. Call after `profiler-stop` — no full pipeline needed.   |
| `mcp__argent__profiler-react-renders`    | Live fiber walk: render counts + durations per component (no profiling session required). |
| `mcp__argent__profiler-fiber-tree`       | Live fiber walk: full component hierarchy as JSON.                                        |
| `mcp__argent__profiler-console-logs`     | Console log entries captured from the app, filterable by level.                           |

## Standard Workflow

**Do not break the profiling sequence mid-flow. Complete all steps in order.**

### Step 1: Start profiling

```json
{ "port": 8081 }
```

Call `profiler-start`. On success, tell the user **clearly** what interaction to perform — e.g.
_"Please scroll the list / switch tabs / open the profile screen. Tell me when done."_
Wait for the user's reply before proceeding.

### Step 2: Stop and collect

```json
{ "port": 8081 }
```

Call `profiler-stop`. Note `duration_ms`, `fiber_renders_captured`, `hook_installed`.
If `hook_installed: false` or `fiber_renders_captured: 0`, warn the user — React commit data may be missing.

### Step 3: Analyze

```json
{
  "port": 8081,
  "project_root": "/path/to/my-app",
  "platform": "ios",
  "rn_version": "0.74.0"
}
```

Call `profiler-analyze`. Read `meta` first: note `reactCompilerEnabled`, `strictModeEnabled`, `buildMode`.

### Step 4: Apply and re-profile

`profiler-analyze` includes a **Suggested Improvements** section with concrete, file-level fixes for the top findings. Read that section and apply the top fix.

After applying a fix, re-profile to confirm the improvement: repeat Step 1 → user interaction → Step 2 → Step 3.

**React Compiler rule:** If `meta.reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out (check `profiler-fiber-tree` for absent `useMemoCache` on that component).

## Important Caveats

- **Dev mode inflation**: `buildMode: "dev"` renders are ~3× slower than production. Prioritize high `normalizedRenderCount` — it scales to prod.
- **Re-run after fixes**: Apply fix → `profiler-start` → reproduce → `profiler-stop` → `profiler-analyze` to confirm `totalRenderMs` dropped.
- **`excluded` is informational**: Components in `animatedSubtrees` and `recyclerChildren` re-render by design — correctly suppressed.
- **Strict Mode**: React Strict Mode double-invokes renders. The pipeline halves `normalizedRenderCount` automatically when detected.

For diagnostic tool usage (live render stats, fiber tree, CPU summary, console logs), see `references/diagnostic-tools.md`.
