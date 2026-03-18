---
name: react-native-profiler
description: Profile a React Native Hermes app to find re-render and CPU performance issues using argent profiler tools. Use when profiling performance, finding slow components, diagnosing re-renders, checking CPU hotspots, or producing a ranked issue report with source-level fixes.
---

## 1. Prerequisites

All profiling goes through argent MCP tools. This workflow requires executing tools on the device.

## 2. Tool Overview

| Tool                       | Purpose                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `profiler-start`           | Start CPU sampling + inject React commit-capture hook. Auto-connects to Metro.           |
| `profiler-stop`            | Stop recording; stores cpuProfile + commitTree in session.                               |
| `profiler-analyze`         | Run 5-stage pipeline → IssueReport with findings sorted by `totalRenderMs` DESC.         |
| `profiler-component-source`| AST lookup: file, line, memoization status, 50 lines of source for a component.          |
| `profiler-cpu-summary`     | Quick CPU hotspot markdown table. Call after `profiler-stop` — no full pipeline needed.   |
| `profiler-react-renders`   | Live fiber walk: render counts + durations per component (no profiling session required). |
| `profiler-fiber-tree`      | Live fiber walk: full component hierarchy as JSON.                                       |
| `profiler-console-logs`    | Console log entries from the app, filterable by level.                                   |

---

## 3. Standard Workflow

**Complete all steps in order — do not break mid-flow.**

### Step 1: Start profiling

Call `profiler-start`. On success:
- if user asked you to perform the profiling, determine how to profile yourself using tools described in `simulator-interact` skill.
- if the user stated they wish to perform the interaction themselves — suggest what interaction to perform (e.g. "scroll the list", "switch tabs") and wait for their reply.

### Step 2: Stop and collect

Call `profiler-stop`. Note `duration_ms`, `fiber_renders_captured`, `hook_installed`.
If `hook_installed: false` or `fiber_renders_captured: 0`, warn the user — React commit data may be missing.

### Step 3: Analyze

Call `profiler-analyze` with `project_root`, `platform`, and `rn_version`. Read `meta` first: note `reactCompilerEnabled`, `strictModeEnabled`, `buildMode`.

### Step 4: Apply fix and re-profile

Read the **Suggested Improvements** section from the analysis. Apply the top fix, then re-profile (Step 1 → user interaction → Step 2 → Step 3) to confirm improvement.

If the user stated they do not want changes applied, return the profiling report without applying fixes but include the suggested improvements.

**React Compiler rule:** If `meta.reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out (check `profiler-fiber-tree` for absent `useMemoCache` on that component).

---

## 4. Important Caveats

- **Dev mode inflation**: `buildMode: "dev"` renders are ~3x slower than production. Prioritize high `normalizedRenderCount` — it scales to prod.
- **Re-run after fixes**: Always re-profile to confirm `totalRenderMs` dropped.
- **`excluded` is informational**: Components in `animatedSubtrees` and `recyclerChildren` re-render by design.
- **Strict Mode**: Double-invokes renders. The pipeline halves `normalizedRenderCount` automatically when detected.
- **Debugger connection**: If interrupted, started profiling also closes. Check debugger status and restart the flow on errors.

For standalone diagnostic tools (live render stats, fiber tree, CPU summary, console logs), see `references/diagnostic-tools.md`.

---

## Quick Reference

| Action                        | Tool                      |
| ----------------------------- | ------------------------- |
| Start profiling session       | `profiler-start`          |
| Stop and collect data         | `profiler-stop`           |
| Full analysis with report     | `profiler-analyze`        |
| Look up component source      | `profiler-component-source`|
| Quick CPU hotspots            | `profiler-cpu-summary`    |
| Live render counts (no session)| `profiler-react-renders` |
| Component hierarchy           | `profiler-fiber-tree`     |
| Console logs                  | `profiler-console-logs`   |
