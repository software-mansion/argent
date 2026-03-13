# Diagnostic Tools

These tools can be called independently without starting a profiling session.

## Live render stats

```json
{ "port": 8081, "top_n": 20 }
```
Call `react-profiler-renders`. Returns render counts and durations per component — useful for spotting hot components before a full profile.

## Component hierarchy

```json
{ "port": 8081, "max_depth": 10, "filter": "MyComponent" }
```
Call `react-profiler-fiber-tree`. Inspect `useMemoCache` presence to confirm React Compiler is active for a given component. If `useMemoCache` is absent, the compiler bailed out for that component — memoization hints are safe to propose.

## Console logs

```json
{ "port": 8081, "level": "error", "limit": 50 }
```
Call `debugger-console-logs`. Filter by `level`: `"error"`, `"warn"`, `"log"`, or omit to get all.

---

# Post-Analysis Query Tools

These require a completed profiling session (`react-profiler-stop` + `react-profiler-analyze`).

## CPU query (replaces react-profiler-cpu-summary)

```json
{ "port": 8081, "mode": "top_functions", "top_n": 15 }
```
Call `profiler-cpu-query`. Modes:
- `top_functions` — global CPU hotspots. Add `time_window_ms: { start, end }` to filter.
- `time_window` — CPU breakdown for a specific time range (e.g. during a slow commit).
- `call_tree` — callers and callees of a specific `function_name`.
- `component_cpu` — aggregate CPU during all commits of a `component_name`.

## Commit query

```json
{ "port": 8081, "mode": "by_component", "component_name": "AppNavigator" }
```
Call `profiler-commit-query`. Modes:
- `by_component` — all commits where a component rendered.
- `by_time_range` — commits in a `time_range_ms` window.
- `by_index` — full detail of a single `commit_index`.
- `cascade_tree` — parent-child re-render cascade for a commit.

## iOS Instruments query

```json
{ "device_id": "<UDID>", "mode": "hang_stacks", "hang_index": 0 }
```
Call `profiler-stack-query` after `ios-instruments-analyze`. Modes:
- `hang_stacks` — full CPU context during a specific hang.
- `function_callers` — who calls a specific native `function_name`.
- `thread_breakdown` — CPU time split by thread, optionally filtered.
- `leak_stacks` — memory leak details, optionally filtered by `object_type`.

## Combined report

```json
{ "port": 8081, "device_id": "<UDID>" }
```
Call `profiler-combined-report` when both React Profiler and iOS Instruments ran in parallel. Automatically correlates iOS hangs with React commits using wall-clock time alignment.
