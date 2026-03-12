# Profiler Pipeline Design

Living document tracking the reasoning behind pipeline architecture decisions.

## Original State → Current State

**Original**: Flat CPU+React analysis, hot commit filter = linear 55% of max heat, React Compiler detection from hot commits only.

**Problem 1 — React Compiler false negative**: Compiler-optimized components render fast → they appeared in cold commits → got discarded before the pipeline ran → `anyRuntimeCompilerDetected` stayed false → output printed a spurious "Compiler not found at runtime" warning.

**Problem 2 — Verbose JSON output**: Full `IssueReport` (commitTimeline, excluded arrays, full CPU list, all findings with every field) flooded the LLM context with noise.

---

## Key Decisions

### Drop CPU from react-profiler-analyze

CPU data is too noisy and hard to attribute to specific component issues without a full flamegraph. `react-profiler-cpu-summary` remains for raw CPU inspection, but `react-profiler-analyze` focuses entirely on React commit data from `__RN_DEVTOOLS_MCP_COMMITS__`.

### cbrt normalization

Matches React DevTools commit bar chart behavior. Better than linear for distinguishing outliers in sessions with mixed duration ranges. A 100ms commit stands out much more clearly than linear would show.

### Absolute floor before cbrt (two-layer threshold)

cbrt alone creates false positives: a 2ms commit can be "hot" relative to a 1ms baseline. The absolute 16ms floor (one dev-mode frame budget at 60fps) gates entry before any normalization is applied.

| Category  | Absolute threshold |
| --------- | ------------------ |
| All clear | all commits < 16ms |
| Warm 🟡   | 16–50ms            |
| Hot 🔴    | > 50ms             |

### React Compiler detection moved to react-profiler-stop

Scan ALL commits in react-profiler-stop (before hot filtering) to set `anyCompilerOptimized`. Store in session. Pass via `sessionMeta.anyCompilerOptimized` into pipeline. Stage 1 (reduce) seeds `anyRuntimeCompilerDetected` from this flag so cold commits contribute to detection.

The "compiler not found at runtime" note in the output only fires when static detection is true AND `anyCompilerOptimized` is false.

### Markdown output over JSON

LLM context efficiency. Field names in JSON consume tokens without adding value. Structured prose with emoji tier indicators is more scannable. The LLM reasons about commit content directly from the rendered text rather than navigating nested JSON keys.

### Annotations param (optional)

`Array<{offsetMs, label}>` where `offsetMs = Date.now() - profileStartWallMs` at action time. `react-profiler-start` records `profileStartWallMs = Date.now()` on the Node.js side. React commit timestamps are `performance.now()` from the device; commits are displayed with timestamps relative to the first commit (t=0 approximation).

**No max-delta cutoff** — always show the most recent prior annotation regardless of elapsed time. The time delta is displayed so the developer/LLM can reason about causality. Example: a hot commit 2.0s after "sent message" suggests an async response handler.

### All-clear path

Prevents the pipeline from always finding "something" even in perfectly smooth sessions. 16ms threshold means a genuinely smooth app explicitly says so rather than manufacturing noise.

### Cap + persist full report

Top 10 hot commits in inline response to stay token-efficient. Full markdown written to `rn-devtools-debug/react-profiler-report.md` for agent to re-query without re-running profiling. Agent can use the Read tool directly on the file.

### Findings threshold: renders ≥ 3 OR maxDuration ≥ 30ms

Pure render-count threshold (≥ 3) misses single heavy renders like navigation-triggered list initialization. The OR condition captures:

- **High-frequency cheap re-renders**: renders quickly but constantly (≥ 3 times across hot commits)
- **Low-frequency expensive renders**: fires once but takes ≥ 30ms (e.g., heavy list init on navigation; ~10ms in production — still significant)

---

## Hook Name Resolution

`fiber._debugHookTypes` is populated automatically in dev builds by React. The capture script already reads it. The pipeline maps changed hook indices to human-readable type names (e.g., `hook[2] → useState`).

Getting hook variable names (e.g., `messages`, `setIsLoading`) is out of scope for now. It would require:

1. Resolving the component source file (AST index already does this)
2. Parsing hook calls in source order via tree-sitter
3. Extracting destructured variable names from each hook call

The AST infrastructure (`06-resolve/ast-index.ts`) exists and this is a natural future enhancement.

---

## Stage Summary

| Stage | File                | Purpose                                                              |
| ----- | ------------------- | -------------------------------------------------------------------- |
| 0     | `00-preprocess.ts`  | Parent chain tracing — annotates cascade commits with root cause     |
| 00    | `00-hot-commits.ts` | Groups commits by index, marks hot/margin, builds HotCommitSummary[] |
| 1     | `01-reduce.ts`      | One-pass React commit aggregation, Welford accumulators              |
| 2     | `02-enrich.ts`      | Derive stats from accumulators                                       |
| 3     | `03-tag.ts`         | False-positive flags (isAnimated, isRecyclerChild)                   |
| 4     | `04-rank.ts`        | Filter, rank, serialize to ComponentFinding[]                        |
| 5     | `05-render.ts`      | Render HotCommitSummary[] + ComponentFinding[] to markdown           |
