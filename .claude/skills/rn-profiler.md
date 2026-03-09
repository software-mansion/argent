# React Native Profiler

Profile a React Native app running on Hermes to identify re-render performance issues.
Produces an `IssueReport` with ranked findings, CPU hotspots, and actionable source-level fixes.

## Prerequisites

**Plan mode check:** This workflow requires executing tools on the device. If you are currently in plan mode, inform the user that profiling cannot run in plan mode and ask them to exit plan mode first (e.g. "Profiling requires running tools on the simulator — please exit plan mode so I can start the session."). Do not attempt to call any profiler tools while in plan mode.

## Tool Overview

| Tool | What it does |
|---|---|
| `profiler-start` | Start CPU sampling + inject React commit-capture hook. Auto-connects to Metro if needed. |
| `profiler-stop` | Stop recording; stores `cpuProfile` + `commitTree` in session. |
| `profiler-analyze` | Run 5-stage pipeline → `IssueReport` with `findings[]` sorted by `totalRenderMs` DESC. |
| `profiler-component-source` | AST lookup: file, line, memoization status, 50 lines of source for a component. |
| `profiler-cpu-summary` | Quick CPU hotspot markdown table. No pipeline needed — call after `profiler-stop`. |
| `profiler-react-renders` | Live fiber walk: render counts + durations per component (no profiling required). |
| `profiler-fiber-tree` | Live fiber walk: full component hierarchy as JSON. |
| `profiler-console-logs` | Console log entries captured from the app, filterable by level. |

## Standard Workflow

**Do not break the profiling sequence mid-flow. Complete all steps in order.**

### Step 1: Start profiling
```json
{ "tool": "profiler-start", "args": { "port": 8081 } }
```
On success, tell the user **clearly** what interaction to perform — e.g.
*"Please scroll the list / switch tabs / open the profile screen. Tell me when done."*
Wait for the user's reply before proceeding.

### Step 2: Stop and collect
```json
{ "tool": "profiler-stop", "args": { "port": 8081 } }
```
Note `duration_ms`, `fiber_renders_captured`, `hook_installed`.
If `hook_installed: false` or `fiber_renders_captured: 0`, warn the user — React commit data may be missing.

### Step 3: Analyze
```json
{
  "tool": "profiler-analyze",
  "args": {
    "port": 8081,
    "project_root": "/path/to/my-app",
    "platform": "ios",
    "rn_version": "0.74.0"
  }
}
```
Read `meta` first: note `reactCompilerEnabled`, `strictModeEnabled`, `buildMode`.

### Step 4: Apply the suggestions

`profiler-analyze` now includes a **Suggested Improvements** section in the report with concrete, file-level fixes for the top findings. Read that section and apply the top fix.

After applying a fix, re-profile to confirm the improvement:
```json
{ "tool": "profiler-start", "args": { "port": 8081 } }
```
Then repeat the user interaction → `profiler-stop` → `profiler-analyze`.

**React Compiler rule:** If `meta.reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo`
unless you confirmed compiler bail-out (check `profiler-fiber-tree` for absent `useMemoCache` on that component).

## Diagnostic Tools (no profiling required)

```json
// Live render stats
{ "tool": "profiler-react-renders", "args": { "port": 8081, "top_n": 20 } }

// Component hierarchy (check for useMemoCache to confirm compiler active)
{ "tool": "profiler-fiber-tree", "args": { "port": 8081, "max_depth": 10, "filter": "MyComponent" } }

// CPU hotspot table (after profiler-stop)
{ "tool": "profiler-cpu-summary", "args": { "port": 8081, "react_only": false } }

// Console logs
{ "tool": "profiler-console-logs", "args": { "port": 8081, "level": "error", "limit": 50 } }
```

## Important Caveats

- **Dev mode inflation**: `buildMode: "dev"` renders are ~3× slower than production. Prioritize high `normalizedRenderCount` — it scales to prod.
- **Re-run after fixes**: After applying a fix → `profiler-start` → reproduce → `profiler-stop` → `profiler-analyze` again to confirm `totalRenderMs` dropped.
- **`excluded` is informational**: Components in `animatedSubtrees` and `recyclerChildren` re-render by design — correctly suppressed.
- **Strict Mode**: React Strict Mode double-invokes renders. The pipeline halves `normalizedRenderCount` automatically when detected.
