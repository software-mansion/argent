---
name: argent-react-native-optimization
description: Optimize a React Native app for performance using argent profiler and debugger tools. Entry-point skill for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to `argent-react-native-profiler` for measurement.
---

## 1. Tools

This skill orchestrates tools from two measurement skills. Load them for full tool reference:

- **`argent-react-native-profiler`** — React/Hermes profiling (renders, commits, CPU).
- **`argent-ios-profiler`** — Native iOS profiling (CPU hotspots, UI hangs, memory leaks).

On react-native apps, use both of the available tool workflows for best coverage.

Quick-access tools (no profiling session required):

- `react-profiler-renders` — live render count table, instant spot-check
- `debugger-evaluate` — run JS in app runtime to test a fix live
- `react-profiler-component-source` — AST lookup for file, line, memoization status

---

## 2. Workflow

**Rule: Profile before optimizing.** Do not apply shotgun optimizations. Measure first, define what "good enough" looks like (target metric + threshold), fix the top offender, re-measure honestly.

1. **Quick scan** — `react-profiler-renders` for a live render count table. Identifies hot components instantly.
2. **Deep measure** — load `argent-react-native-profiler` skill. `react-profiler-start` → interact → `react-profiler-stop` → `react-profiler-analyze`.
3. **Inspect** — `react-profiler-component-source` per finding. `react-profiler-fiber-tree` to trace component ancestry and render cost.
4. **Verify correctness** - before attempting fixing, recollect the information from steps &1, &2, &3 and make logical conclusion whether the approach is worth undertaking
5. **Fix** — apply one fix from §3. Validate with `debugger-evaluate` before committing.
6. **Re-measure** — re-run step 1 or 2. Report whether the target metric improved, regressed, or stayed flat. Check whether the fix introduced regressions in other areas (e.g., fewer re-renders but higher CPU, or new jank in a different screen). If no net benefit or unacceptable tradeoffs, revert. **One fix per cycle** — never batch. When the measurement involves simulator interaction, record the interaction as a flow (`argent-create-flow` skill) before the first run so all subsequent cycles replay identical steps. If a recorded flow breaks after applying a fix (e.g., UI layout changed), follow `argent-create-flow` skill §10 to repair the flow rather than silently discarding it.

---

## 3. Fix Reference

Match `react-profiler-analyze` / `react-profiler-renders` findings to fixes:

| Finding                                            | Fix                                                                           | Detail                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Re-renders with same props                         | `React.memo(Comp)`                                                            | **Skip if React Compiler active** — `react-profiler-analyze` reports compiler status per component |
| Expensive recomputation / unstable callbacks       | `useMemo(fn, [deps])` / `useCallback(fn, [deps])`                             | `useCallback` must pair with `React.memo` on child                                                 |
| Inline objects/arrays in JSX                       | `StyleSheet.create()` / module const                                          | New ref every render breaks shallow equality                                                       |
| List jank                                          | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` | Or `@shopify/flash-list` with `estimatedItemSize`                                                  |
| JS-thread animation jank                           | `useNativeDriver: true` or `react-native-reanimated`                          | `useNativeDriver` only for `transform`/`opacity`                                                   |
| Heavy work during transitions                      | `InteractionManager.runAfterInteractions()`                                   | Defer until animation completes                                                                    |
| Slow startup                                       | Hermes + inline requires in `metro.config.js`                                 | Lazy `require()` for heavy modules                                                                 |
| Redundant, heavy, unoptimized or n+1 network calls | `view-network-logs` → `view-network-request-details`                          | Batch, debounce, or cache at data layer                                                            |

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
4. **Fix top-down** — apply fixes starting from worst offender, re-measure after each. Report honestly whether each fix helped, was neutral, or introduced regressions.

Use `react-profiler-renders` as a live pre-scan to validate static findings against runtime behavior.
