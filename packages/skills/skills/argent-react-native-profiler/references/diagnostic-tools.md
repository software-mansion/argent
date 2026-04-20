# Diagnostic Tools

These tools can be called independently without starting a profiling session.

## Live render stats

```json
{ "port": 8081, "device_id": "<UDID>", "top_n": 20 }
```

Call `react-profiler-renders`. Returns render counts and durations per component — useful for spotting hot components before a full profile.

## Component hierarchy

```json
{ "port": 8081, "device_id": "<UDID>", "max_depth": 10, "filter": "MyComponent" }
```

Call `react-profiler-fiber-tree`. Inspect `useMemoCache` presence to confirm React Compiler is active for a given component. If `useMemoCache` is absent, the compiler bailed out for that component — memoization hints are safe to propose.

## Console logs

```json
{ "port": 8081, "device_id": "<UDID>" }
```

Call `debugger-log-registry`. Returns a summary with entry counts by level, message clusters, and the log file path. Use `Grep`/`Read` on the log file to filter by level or search for specific messages.

---

# Post-Analysis Query Tools

These require a completed profiling session (`react-profiler-stop` + `react-profiler-analyze`).

## CPU query (replaces react-profiler-cpu-summary)

```json
{ "port": 8081, "device_id": "<UDID>", "mode": "top_functions", "top_n": 15 }
```

Call `profiler-cpu-query`. Modes:

- `top_functions` — global CPU hotspots. Add `time_window_ms: { start, end }` to filter.
- `time_window` — CPU breakdown for a specific time range (e.g. during a slow commit).
- `call_tree` — callers and callees of a specific `function_name`.
- `component_cpu` — aggregate CPU during all commits of a `component_name`.

## Commit query

```json
{ "port": 8081, "device_id": "<UDID>", "mode": "by_component", "component_name": "AppNavigator" }
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

Call `profiler-stack-query` after `native-profiler-analyze`. Modes:

- `hang_stacks` — full CPU context during a specific hang.
- `function_callers` — who calls a specific native `function_name`.
- `thread_breakdown` — CPU time split by thread, optionally filtered.
- `leak_stacks` — memory leak details, optionally filtered by `object_type`.

## Combined report

```json
{ "port": 8081, "device_id": "<UDID>" }
```

Call `profiler-combined-report` when both React Profiler and iOS Instruments ran in parallel. Automatically correlates iOS hangs with React commits using wall-clock time alignment.

## Session reload

```json
{ "mode": "list" }
```

Call `profiler-load`. Modes:

- `list` — show all saved profiling sessions (React + iOS) in `/tmp/argent-profiler-cwd/`.
- `load_react` — reload a React profiler session by `session_id` + `device_id`. Populates the `port:device_id`-keyed in-memory cache for `profiler-cpu-query` and `profiler-commit-query` (which must be called with the same `device_id` afterward).
- `load_native` — re-parse native profiler XML by `session_id` and `device_id`. Populates session for `profiler-stack-query`.

Use this to revisit an earlier profiling session without re-profiling. Each `react-profiler-analyze` run saves raw data with a unique timestamp.
