---
name: react-native-optimization
description: Optimize a React Native app for performance using argent profiler and debugger tools. Entry-point skill for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to `react-native-profiler` for measurement.
---

## 1. Tools

| Tool | What it gives you | When to use |
| ---- | ----------------- | ----------- |
| `react-profiler-renders` | Live render counts + durations per component (markdown table, top N). | First thing to run — instant spot-check of what re-renders most. |
| `react-profiler-start` / `react-profiler-stop` | Records CPU samples + React commit data with per-fiber durations, prop/hook change tracking, and React Compiler detection. | When you need precise commit-level data, not just counts. |
| `react-profiler-analyze` | Ranked report: hot commits (≥16ms), render cascades, root causes, memoization status via AST. Pass `annotations` to tag user actions by time offset. | After `react-profiler-stop`. **Primary diagnostic** — tells you exactly what to fix. |
| `react-profiler-component-source` | AST lookup → file, line, `isMemoized`, `hasUseCallback`, `hasUseMemo`, 50 lines of source. | Per finding from `react-profiler-analyze` — read the code before proposing a fix. |
| `react-profiler-fiber-tree` | Live component hierarchy JSON with `actualDuration`, `selfBaseDuration`. Filter by regex. | Trace component ancestry; understand render cost distribution across the tree. |
| `profiler-cpu-query` | Targeted CPU investigation: top functions, time-windowed CPU, call trees, per-component CPU breakdown. | Drill into CPU hotspots after `react-profiler-analyze`. Use `mode=component_cpu` to see what JS ran during a component's renders. |
| `ios-profiler-start` / `ios-profiler-stop` | Records native CPU samples, UI hangs, and memory leaks via Instruments (`xctrace`). | When jank or bottlenecks may be in the native layer, not JS. Load `ios-profiler` skill for full workflow. |
| `ios-profiler-analyze` | Severity-ranked report: native CPU hotspots, main-thread hangs with suspected functions, memory leaks with responsible frames. | After `ios-profiler-stop`. |
| `profiler-combined-report` | Cross-correlates React commits with native Instruments hangs via wall-clock alignment. Shows which React renders overlap with native hangs. | After both React and iOS profiling sessions complete. |
| `profiler-stack-query` | iOS-only drill-down: hang stacks, function callers/callees, thread CPU breakdown, leak stacks. | Drill into specific native findings from `ios-profiler-analyze`. |

### Inspection

| Tool | What it gives you | When to use |
| ---- | ----------------- | ----------- |
| `debugger-evaluate` | Run arbitrary JS in the app runtime. Returns the evaluated result. | Test a fix live (e.g. check memoization, read state) before editing source. |
| `debugger-component-tree` | On-screen fiber tree with tap coords, text, testIDs. Off-screen/wrapper nodes pruned. | Understand current screen layout; find which components are mounted. |
| `debugger-inspect-element` | Component hierarchy at (x,y) with source file:line and code fragment per ancestor. | Trace a visible element back to its source definition. |
| `view-network-logs` | Paginated HTTP request log: method, URL, status, size, duration, requestId. | Spot slow/duplicate/waterfall API calls that stall renders. |
| `view-network-request-details` | Full request/response for a requestId: headers (sensitive redacted), body (truncated at 1000 chars), timing. | Drill into a specific slow or failing request. |
| `debugger-log-registry` | Console log summary + file path for grepping. | Check for runtime warnings, error spam, or performance-related logs. |

---

## 2. Workflow

**Rule: Profile before optimizing.** Do not apply shotgun optimizations. Measure first, fix the top offender, re-measure.

1. **Quick scan** — `react-profiler-renders` for a live render count table. Identifies hot components instantly.
2. **Deep measure** — load `react-native-profiler` skill. `react-profiler-start` → interact → `react-profiler-stop` → `react-profiler-analyze`.
3. **Inspect** — `react-profiler-component-source` per finding. `react-profiler-fiber-tree` to trace component ancestry and render cost.
4. **Fix** — apply one fix from §3. Validate with `debugger-evaluate` before committing.
5. **Re-measure** — re-run step 1 or 2. Confirm improvement. **One fix per cycle** — never batch.

---

## 3. Fix Reference

Match `react-profiler-analyze` / `react-profiler-renders` findings to fixes:

| Finding | Fix | Detail |
| ------- | --- | ------ |
| Re-renders with same props | `React.memo(Comp)` | **Skip if React Compiler active** — `react-profiler-analyze` reports compiler status per component |
| Expensive recomputation / unstable callbacks | `useMemo(fn, [deps])` / `useCallback(fn, [deps])` | `useCallback` must pair with `React.memo` on child |
| Inline objects/arrays in JSX | `StyleSheet.create()` / module const | New ref every render breaks shallow equality |
| List jank | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` | Or `@shopify/flash-list` with `estimatedItemSize` |
| JS-thread animation jank | `useNativeDriver: true` or `react-native-reanimated` | `useNativeDriver` only for `transform`/`opacity` |
| Heavy work during transitions | `InteractionManager.runAfterInteractions()` | Defer until animation completes |
| Slow startup | Hermes + inline requires in `metro.config.js` | Lazy `require()` for heavy modules |
| Redundant, heavy, unoptimized or n+1 network calls | `view-network-logs` → `view-network-request-details` | Batch, debounce, or cache at data layer |

---

## 4. App-Wide Optimization

When optimizing the entire app, **dispatch parallel sub-agents** — one per distinct code feature.

1. **Discover targets** — read project source structure to identify major features/modules.
2. **Spawn one sub-agent per target** in parallel. Each agent:
   - Analyzes the code for known anti-patterns and performance issues (§3)
   - Runs `react-profiler-component-source` on suspect components to check memoization status
   - Compares code to best practices — static analysis, not E2E testing
   - Returns: feature name, ranked findings with file:line, suggested fix from §3
3. **Merge results** — prioritize findings by severity across all sub-agents.
4. **Fix top-down** — apply fixes starting from worst offender, re-measure after each.

Use `react-profiler-renders` as a live pre-scan to validate static findings against runtime behavior.

## Related Skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Full React profiler workflow: measure → analyze → repeat |
| `ios-profiler` | Native iOS profiling (CPU hotspots, UI hangs, memory leaks) via Instruments |
| `react-native-app-workflow` | Build/run app, Metro, reload after changes |
| `metro-debugger` | Breakpoints, stepping, JS pause/resume — for correctness issues found during optimization |
| `test-ui-flow` | Verify optimized flows still work |
| `simulator-interact` | Navigate and interact with the simulator to trigger code paths for profiling |
