---
name: react-native-optimization
description: Optimize a React Native app for performance using argent profiler and debugger tools. Entry-point skill for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to `react-native-profiler` for measurement.
---

## 1. Tools

| Tool | Use for |
| ---- | ------- |
| `profiler-start` / `profiler-stop` | Record CPU + React commit data over an interaction window |
| `profiler-analyze` | **Primary diagnostic.** Ranked issue report: hot commits, render cascades, root causes |
| `profiler-react-renders` | Live render counts per component — fast spot-check, no session needed |
| `profiler-fiber-tree` | Component hierarchy; check `useMemoCache` to verify React Compiler status |
| `profiler-component-source` | AST lookup: file, line, memoization status, 50 lines of source |
| `profiler-cpu-summary` | CPU flamegraph hotspots — only for non-React CPU work (regex, crypto) |
| `debugger-evaluate` | Run JS in app runtime — test fixes live before committing |
| `debugger-component-tree` | Fiber tree with tap coords — discover what's on screen |
| `view-network-logs` | Spot slow/redundant API calls causing render stalls |
| `profiler-console-logs` | Console log dump filtered by level |

For the full profiler start→stop→analyze workflow, load the `react-native-profiler` skill.

---

## 2. Workflow

**Rule: Profile before optimizing.** Do not apply shotgun optimizations. Measure first, fix the top offender, re-measure.

1. **Measure** — load `react-native-profiler` skill. `profiler-start` → interact → `profiler-stop` → `profiler-analyze`.
2. **Inspect** — call `profiler-component-source` on each finding. Check React Compiler via `profiler-fiber-tree`.
3. **Fix** — apply one fix from §3. Validate with `debugger-evaluate` before committing.
4. **Re-measure** — re-profile same interaction. Confirm improvement.
5. **Repeat** — next finding. **One fix per cycle** — never batch.

---

## 3. Fix Reference

Match `profiler-analyze` / `profiler-react-renders` findings to fixes:

| Finding | Fix | Detail |
| ------- | --- | ------ |
| Re-renders with same props | `React.memo(Comp)` | Skip if React Compiler active (`useMemoCache` present in `profiler-fiber-tree`) |
| Expensive recomputation | `useMemo(fn, [deps])` | Only for measurably expensive work |
| Unstable callback breaks memo | `useCallback(fn, [deps])` | Pair with `React.memo` on child — alone it does nothing |
| Inline objects in JSX | `StyleSheet.create()` / module const | New ref every render breaks shallow equality |
| List jank | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` | Or `@shopify/flash-list` with `estimatedItemSize` |
| Index-keyed lists | Stable `keyExtractor` by item ID | Index keys → full remount on reorder |
| JS-thread animation jank | `useNativeDriver: true` or `react-native-reanimated` | `useNativeDriver` only for `transform`/`opacity` |
| Heavy work during transitions | `InteractionManager.runAfterInteractions()` | Defer until animation completes |
| Slow startup | Hermes + inline requires in `metro.config.js` | Lazy `require()` for heavy modules |
| Console.log in production | `babel-plugin-transform-remove-console` | Sync I/O on JS thread |
| Redundant network calls | Inspect via `view-network-logs` | Batch, debounce, or cache at data layer |

---

## 4. App-Wide Optimization

When optimizing the entire app, **dispatch parallel sub-agents** - one per distinct code feature that should be targeted for potential optimization.

1. **Discover optimization targets** — read project structure from source.
2. **Spawn one sub-agent per optimization target** in parallel. Each agent:
   - Navigates to the target
   - Runs profiling on discrete code units that could be sub-optimal
   - Compares code to the known best-practices, tries statically finding performance issues
   - Reports the findings to you
3. **Merge results** — sort all findings by `totalRenderMs` DESC across all optimizations.
4. **Fix top-down** — apply fixes globally starting from worst offender, re-profile after each.

Use `profiler-react-renders` per screen as a fast pre-scan before committing to full profiling sessions.

---

## Related Skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Profile before fixing, re-profile after. This skill describes to how use the profiling tools |
| `simulator-interact` | Navigate and interact during profiling |
| `react-native-app-workflow` | Build/run app, Metro, reload after changes |
| `metro-debugger` | Breakpoints, stepping, component inspection |
| `test-ui-flow` | Verify optimized flows still work |
