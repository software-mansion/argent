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

## CPU hotspot table

```json
{ "port": 8081, "react_only": false }
```
Call `react-profiler-cpu-summary` after `react-profiler-stop`. Returns a markdown table of the top CPU consumers without running the full `react-profiler-analyze` pipeline.

## Console logs

```json
{ "port": 8081, "level": "error", "limit": 50 }
```
Call `debugger-console-logs`. Filter by `level`: `"error"`, `"warn"`, `"log"`, or omit to get all.
