---
name: react-native-optimization
description: Optimize a React Native app for performance using argent profiler and debugger tools. Entry-point skill for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to `react-native-profiler` for measurement.
---

## 1. Tools

| Tool | What it gives you | When to use |
| ---- | ----------------- | ----------- |
| `profiler-react-renders` | Live render counts + durations per component (markdown table, top N). **No session needed.** | First thing to run — instant spot-check of what re-renders most. |
| `profiler-start` / `profiler-stop` | Records CPU samples + React commit data with per-fiber durations, prop/hook change tracking, and React Compiler detection. | When you need precise commit-level data, not just counts. |
| `profiler-analyze` | Ranked report: hot commits (≥16ms), render cascades, root causes, memoization status via AST. Pass `annotations` to tag user actions by time offset. | After `profiler-stop`. **Primary diagnostic** — tells you exactly what to fix. |
| `profiler-component-source` | AST lookup → file, line, `isMemoized`, `hasUseCallback`, `hasUseMemo`, 50 lines of source. | Per finding from `profiler-analyze` — read the code before proposing a fix. |
| `profiler-fiber-tree` | Live component hierarchy JSON with `actualDuration`, `selfBaseDuration`. Filter by regex. Check for `useMemoCache` to confirm React Compiler is active per component. | Trace component ancestry; verify compiler status before suggesting manual memo. |
| `profiler-cpu-summary` | CPU flamegraph hotspots by self-time (markdown table). `react_only: true` filters to PascalCase components. | **Only for non-React CPU issues** (regex, crypto, heavy computation). Not for render analysis. |

### Inspection

| Tool | What it gives you | When to use |
| ---- | ----------------- | ----------- |
| `debugger-evaluate` | Run arbitrary JS in the app runtime. Returns the evaluated result. | Test a fix live (e.g. check memoization, read state) before editing source. |
| `debugger-component-tree` | On-screen fiber tree with tap coords, text, testIDs. Off-screen/wrapper nodes pruned. | Understand current screen layout; find which components are mounted. |
| `debugger-inspect-element` | Component hierarchy at (x,y) with source file:line and code fragment per ancestor. | Trace a visible element back to its source definition. |
| `view-network-logs` | Paginated HTTP request log: method, URL, status, size, duration, requestId. | Spot slow/duplicate/waterfall API calls that stall renders. |
| `view-network-request-details` | Full request/response for a requestId: headers (sensitive redacted), body (truncated at 1000 chars), timing. | Drill into a specific slow or failing request. |
| `profiler-console-logs` | Console log entries filtered by level (`log`/`warn`/`error`/`all`). | Check for runtime warnings, error spam, or performance-related logs. |

---

## 2. Workflow

**Rule: Profile before optimizing.** Do not apply shotgun optimizations. Measure first, fix the top offender, re-measure.

1. **Quick scan** — `profiler-react-renders` for a live render count table. Identifies hot components instantly.
2. **Deep measure** — load `react-native-profiler` skill. `profiler-start` → interact → `profiler-stop` → `profiler-analyze`.
3. **Inspect** — `profiler-component-source` per finding. `profiler-fiber-tree` to check React Compiler (`useMemoCache`).
4. **Fix** — apply one fix from §3. Validate with `debugger-evaluate` before committing.
5. **Re-measure** — re-run step 1 or 2. Confirm improvement. **One fix per cycle** — never batch.

---

## 3. Fix Reference

Match `profiler-analyze` / `profiler-react-renders` findings to fixes:

| Finding | Fix | Detail |
| ------- | --- | ------ |
| Re-renders with same props | `React.memo(Comp)` | **Skip if React Compiler active** — check `useMemoCache` via `profiler-fiber-tree` |
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
   - Runs `profiler-component-source` on suspect components to check memoization status
   - Compares code to best practices — static analysis, not E2E testing
   - Returns: feature name, ranked findings with file:line, suggested fix from §3
3. **Merge results** — prioritize findings by severity across all sub-agents.
4. **Fix top-down** — apply fixes starting from worst offender, re-measure after each.

Use `profiler-react-renders` as a live pre-scan to validate static findings against runtime behavior.

## Related Skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Full profiler workflow: measure → analyze → repeat |
| `react-native-app-workflow` | Build/run app, Metro, reload after changes |
| `metro-debugger` | Breakpoints, stepping, component inspection |
| `test-ui-flow` | Verify optimized flows still work |
| `simulator-interact` | Navigate and interact with the simulator - cannot be used by sub-agents |
