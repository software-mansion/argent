---
name: argent-react-native-profiler
description: Profile a React Native Hermes app to measure re-render and CPU performance using argent profiler tools. Use when optimizing for performance, measuring before/after a fix, spotting slow components, diagnosing re-renders, checking CPU hotspots, or producing a ranked issue report.
---

This skill is complementary to `argent-react-native-optimization`, not a replacement for it.

Physical iPhone: not supported; `react-profiler-*` reject `kind: "device"`. Profile on a simulator.

## 1. Tools

### React Profiler (Hermes / React commits)

- `react-profiler-start` / `react-profiler-stop`: record CPU samples and React commits around an interaction.
- `react-profiler-analyze`: turn the recording into a ranked report: hot commits with the JS functions that ran during each.
- `react-profiler-status`: **only after an interruption** (debugger drop, Metro reload, pause, subagent handoff, any doubt), never otherwise. A debugger drop also ends the recording; check status before stopping or restarting.
- `react-profiler-component-source`: source, location and memoization status of a component the report flagged.
- `react-profiler-renders`: how many instances of each component are mounted in the top 30 levels of the tree, with their last render time; no session needed. It does not count re-renders: record a profile for that.
- `react-profiler-fiber-tree`: live component hierarchy, no session needed, for tracing a component's ancestry.

### Drill-down queries (after analyze)

- `profiler-cpu-query`: JS CPU: top functions, a time window, a function's call tree, CPU during a component's commits.
- `profiler-commit-query`: React commits by component, time range, commit index, or cascade tree.
- `profiler-stack-query`: native data: hang stacks, function callers, thread breakdown, leak details.
- `profiler-combined-report`: correlates native hangs with React commits when both profilers ran.
- `profiler-load`: reload an earlier session from disk for the query tools.

For native profiling on its own, see the `argent-native-profiler` skill.

## 2. Guidelines

- Start `react-profiler-start` and `native-profiler-start` together, as `react-profiler-start` describes. If the user wants only native profiling, follow `argent-native-profiler`.
- **Never move on silently after a report.** The report is the starting point: ask the user whether to investigate further with the query tools, implement fixes and re-profile, or stop.
- **Record the interaction as an e2e test** (`argent-create-e2e` skill) before the first run when profiling needs a specific interaction sequence (scroll a list, navigate screens, trigger an animation), then replay it for every later run. This removes interaction variance from before/after comparisons. It matters most when re-profiling after a fix, comparing several sessions, or when the path is more than 2-3 steps.

## 3. Workflow

**Complete all steps in order; do not break mid-flow.**

### Step 1: Start profiling

Before starting, define lightweight success criteria with the user: which metric matters most (e.g. `totalRenderMs`, a specific commit's duration, a component's render count) and what change would be meaningful.

Start the profilers as described in §2. **Save `startedAtEpochMs` from the response** for annotations. Every later profiler and query call in this session must use the same `device_id`. Then:

- If the user asked you to profile, drive the interaction yourself (`argent-device-interact` skill).
- If the user wants to interact themselves, suggest what to do (e.g. "scroll the list", "switch tabs") and wait for their reply.

While a profiler records, interaction tools return no automatic screenshot or element tree, so the capture does not load the app. Call `screenshot` or `describe` when you need to see the screen; interaction tools still wait for the screen to settle before they return, so add no wait of your own; on an Android emulator each screenshot during a profile takes one frame in about 100 ms and does not wake the screen capture; on a physical Android device it takes about 150–200 ms and briefly wakes the device screen capture, so take them sparingly there.

#### Annotate every interaction

After each `gesture-tap` or `gesture-swipe`, record an annotation with `offsetMs = timestampMs - startedAtEpochMs`, using the `timestampMs` the gesture returned. Never use `Date.now()`; only the server-side timestamps. Annotate _every_ interaction, back-navigation swipes included, and pass them all to `react-profiler-analyze` in Step 3.

### Step 2: Stop and collect

Call `react-profiler-stop` **and** `native-profiler-stop` in parallel (skip the native one only if you did not start it). If `fiber_renders_captured` is 0, warn the user that React commit data may be missing.

### Step 3: Analyze

Call `react-profiler-analyze` with your annotations. Check the report's React Compiler and build-mode lines before proposing fixes.

If both profilers ran, also call `native-profiler-analyze`, then **you must** call `profiler-combined-report`: it surfaces correlations the individual reports miss.

### Step 4: Assess results

Judge whether the results actually explain what is wrong. **Do not assume an improvement always exists**; check the findings against how React Native works, give honest feedback, and be ready to change approach.

### Step 5: Present findings and ask about next steps

Summarize the key findings, whether there is room for improvement, and how further work could affect performance. Then ask the user how to proceed (§2).

### Step 6: Drill-down investigation (iterative)

Chain the query tools from what the report flags:

- **Slow commit** → `profiler-commit-query` `by_index` (every component, props changes, parent cascade) or `cascade_tree` (who triggered whom).
- **Slow component** → `profiler-cpu-query` `component_cpu` → `call_tree` for the hot function → read the source → propose a fix.
- **A time range** → `profiler-commit-query` `by_time_range`, or `profiler-cpu-query` `time_window`.
- **Native hang or leak** → `profiler-stack-query` `hang_stacks` / `leak_stacks`; correlate the hang's timing with React commits.

Pass component names exactly as the report prints them; the wrapped name (`Memo(...)`, `Forget(...)`, `ForwardRef(...)`) resolves too. Repeat until you find the root-cause function and file, judging the evidence as in Step 4. After each round, ask the user whether to keep digging or move to fixing.

### Step 7: Reload a previous session

To revisit earlier data, e.g. to compare before and after a fix: `profiler-load` mode `list`, then `load_react` and/or `load_native` with the `session_id` and the `device_id`. **Pass that same `device_id` to the query tools afterwards**, or they miss the reloaded data.

### Step 8: Apply fix and re-profile

Read the bottleneck's source (`react-profiler-component-source` or the Read tool), apply the fix, then re-profile the same scenario (Step 1 → interaction → Steps 2-4). Report honestly whether the target metric improved, stayed flat, or regressed, and whether any _other_ metric got worse (e.g. fewer renders but more CPU time, or a different component now re-renders more). If the fix brought no net benefit or unacceptable tradeoffs, revert and reconsider.

If the interaction was recorded as an e2e test, replay it with `e2e-execute` instead of repeating the steps by hand. If the replay fails (e.g. a UI fix changed the layout), follow `argent-create-e2e`'s [Diagnose a replay failure](../argent-create-e2e/references/reliability-and-recovery.md#diagnose-a-replay-failure) before retrying the profiling cycle.

If the user does not want changes, present the report and suggest the fix without applying it.

**React Compiler rule:** do NOT propose `useCallback`/`useMemo`/`React.memo` for a component the report marks ✓ (compiled). For a component in your source marked ⚠️ (bailout suspected), fix what stops the compiler instead.

## 4. Caveats

- **Dev builds** render ~3x slower than production (the report notes it). Prioritize render counts over durations: counts carry over to production. They are already halved when Strict Mode double-invokes renders.
- **Live API data** may differ between runs (payload sizes, item counts) and shift render counts and durations independently of your fix. Note when data-dependent components vary.
- **Run-to-run noise:** variations under ~10-15% in commit duration may be noise; only treat consistent, directional changes as signal.
- **Profiler overhead:** if the native profile shows `JSLexer`, `JSONEmitter` or Hermes internals dominating the JS thread, that is instrumentation cost, not app work. Discount those entries.
