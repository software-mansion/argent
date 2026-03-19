# iOS Instruments Pipeline Design

Living document tracking the reasoning behind pipeline architecture decisions.

## Architecture Overview

**3-tool flow**: `ios-profiler-start` → `ios-profiler-stop` → `ios-profiler-analyze`

1. **Start** — Detects the running app process on the simulator, spawns `xctrace record` attached to it.
2. **Stop** — Sends SIGINT to xctrace, waits for process exit, exports the `.trace` bundle to 3 XML files (CPU time-profile, potential-hangs, leaks).
3. **Analyze** — Parses the 3 XMLs, runs a 2-stage pipeline, renders a markdown report.

**2-stage processing** (after XML parsing):

- **Stage 1 — Correlate**: Hang–CPU time-window correlation, leak aggregation by object type.
- **Stage 2 — Aggregate**: CPU hotspot grouping by dominant function + normalized thread, min-weight filtering, hang-overlap flagging.

---

## Key Decisions

### XML parser: id/ref deduplication

xctrace XML uses an id/ref scheme for deduplication — a `<backtrace id="42">` element defines a backtrace once, then later rows reference it with `<backtrace ref="42"/>`. Same for `<binary>`, `<frame>`, and hang field values. The parser maintains registries for each element type and resolves refs on the fly. Without this, most rows would have empty fields since xctrace only emits the full definition once.

### Regex-based XML extraction

Full DOM parsing of xctrace XML is impractical — files can be tens of MB with deeply nested structures. The parser uses targeted regex extraction (`/<row>[\s\S]*?<\/row>/g`, attribute-level patterns) to pull only the fields we need. This keeps memory usage bounded and avoids depending on an XML library for what is effectively a flat table with ref indirection.

### Dominant function detection

Stacks are leaf-first (deepest frame at index 0). To find the most actionable frame, a 3-tier priority is used:

1. **First pass**: First non-system, non-hex frame that does **not** match `RN_FRAMEWORK_SIGNATURES` — prefers user code and third-party libraries (FullStory, Firebase, Sentry, etc.) as these are directly actionable by the developer.
2. **Second pass**: First non-system, non-hex-address frame (including RN framework internals like `RCT`, `Yoga`, `Hermes`, `JSI`, `React`, etc.) — picked only if no user/third-party code was found.
3. **Fallback**: First named frame, then `stack[0]`.

This ensures third-party libraries and user code are surfaced over RN framework internals, while system frames (`/usr/lib/`, `/System/Library/`, `/Library/Developer/CoreSimulator/`) are skipped entirely.

### System library filtering

Frames from binaries whose paths start with `/usr/lib/`, `/System/Library/`, or `/Library/Developer/CoreSimulator/` are marked as system frames. These are excluded from app call chains and deprioritized in dominant function detection. The goal is to focus the report on app code, not framework internals the developer cannot change.

### Hang–CPU correlation via time windows

Each hang has a `startNs` and `durationNs`. The correlator filters CPU samples whose timestamps fall within `[startNs, startNs + durationNs]`, then aggregates dominant functions and app call chains from those samples. This answers "what was the app doing while the UI was frozen" — the most actionable question for hang debugging.

Top 5 suspected functions and top 3 call chains (ranked by sample frequency within the window) are attached to each hang.

### Call chain extraction

App call chains are the non-system, non-hex-address frames from a stack, preserved in stack order. They form readable paths like `MyComponent > render > measureText`. Chains are aggregated by frequency within each CPU hotspot group so the report shows the most common execution path, not a random sample.

### Leaks can't correlate with CPU

Leak data from xctrace is a static summary — total count and size by object type, with a responsible frame and library. Unlike hangs, leaks have no timestamps and no stack samples at specific points in time. There is no way to determine when allocations occurred, so time-window correlation with CPU samples is impossible. Leaks are reported independently with severity RED.

### Severity thresholds

| Category    | Condition                               | Severity     |
| ----------- | --------------------------------------- | ------------ |
| CPU Hotspot | weight > 15% of total                   | RED          |
| CPU Hotspot | weight 3–15%                            | YELLOW       |
| CPU Hotspot | weight < 3%                             | filtered out |
| UI Hang     | type contains "severe" or equals "hang" | RED          |
| UI Hang     | type is "microhang"                     | YELLOW       |
| Memory Leak | all                                     | RED          |

The 3% minimum weight filter prevents noise — xctrace captures thousands of samples and most functions appear briefly. 15% RED threshold flags functions consuming significant wall time. All leaks are RED because any leak is a bug regardless of size.

### Thread normalization

Raw thread names from xctrace are inconsistent (`"main thread"`, `"Main Thread"`, `"com.apple.main-thread"`). The normalizer:

- Maps main thread variants → `"Main Thread"`
- Maps Hermes/JS thread variants → `"JS/Hermes"`
- Strips hex PID suffixes (`"AppName 0x1e4715 (…)"` → `"AppName"`)

This ensures CPU hotspots from the same logical thread group together rather than fragmenting across name variants.

### Markdown output over JSON

Same rationale as the React profiler pipeline: LLM context efficiency. JSON field names consume tokens without adding value. Structured markdown with severity indicators and tables is more scannable. The report is also written to `${traceFile}-report.md` so the agent can re-read it without re-running profiling.

### All-clear path

If zero bottlenecks survive filtering, the report says "All clear" rather than manufacturing findings. Prevents false alarms on well-performing apps.

---

## Stage Summary

| Stage | File                       | Purpose                                                                                   |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------- |
| 0     | `pipeline/xml-parser.ts`   | Parse 3 XMLs in parallel — id/ref deduplication, frame/binary resolution                  |
| 1     | `pipeline/01-correlate.ts` | Hang–CPU time-window correlation, leak aggregation by object type                         |
| 2     | `pipeline/02-aggregate.ts` | CPU hotspot grouping by dominant function + thread, min-weight filter, hang-overlap flags |
| —     | `render.ts`                | Render bottlenecks to markdown with summary table, per-category sections, suggestions     |
