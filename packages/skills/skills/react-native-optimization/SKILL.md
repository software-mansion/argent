---
name: react-native-optimization
description: Optimize a React Native app for performance using a structured 4-phase pipeline — lint sweep, pattern grep, semantic sweep, and visual profiling. Entry-point skill for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to `react-native-profiler` for measurement.
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

## 2. Optimization Pipeline

**Rule: Systematic coverage beats ad-hoc reading.** The agent's natural behavior is to read files and notice problems — this catches high-signal issues but misses mechanical, repetitive patterns. The 4-phase pipeline below ensures deterministic coverage.

When optimizing the entire app, execute all four phases in order. For targeted optimization of a single component or screen, start at Phase 4 (profile) and use Phases 1–3 scoped to the relevant files.

---

### Phase 1: LINT SWEEP (deterministic — catches ~120 issue types)

**Goal:** Catch all mechanically-detectable issues before the agent reads any code. Run linters with an RN-specific ruleset, parse output into a structured issue list, then process each hit.

Run ESLint (or the project's configured linter) with these rules enabled. If the project has no ESLint config, run with a temporary config targeting these rules:

| Rule | What it catches | Expected volume |
| ---- | --------------- | --------------- |
| `react-native/no-inline-styles` | Inline `style={{}}` in JSX — creates new object refs every render | High (~80+) |
| `react/no-array-index-key` | `key={index}` in `.map()` — breaks reconciliation on reorder | Medium (~20+) |
| `@typescript-eslint/no-explicit-any` | `any` types — masks type errors, prevents optimization | Low (~5-10) |
| `prefer-template` | String concatenation with `+` instead of template literals | Low (~2-5) |
| `@typescript-eslint/no-unused-vars` | Unused variables and destructured values | Low (~3-5) |
| `react-hooks/exhaustive-deps` | Missing or incorrect hook dependency arrays | Medium (~5-10) |

**Procedure:**

1. Check if the project already has an ESLint config. If so, run `npx eslint --no-eslintrc --rule '{rule}' --format json {src_dir}` for each rule above, OR run with the project's config if it already includes these rules.
2. If no ESLint is configured, run with `--no-eslintrc` and specify rules inline.
3. Parse the JSON output into a structured list: `file:line → rule → message`.
4. Process each hit — some may be intentional (e.g., inline styles in a one-off animation). Use judgment to skip false positives.
5. For `react-hooks/exhaustive-deps` findings: these require semantic understanding. Collect them here but fix them in Phase 3 where the agent can reason about correct dependencies.

**Do NOT skip this phase.** The lint sweep catches issues the agent will never notice by reading files, because they look harmless at a glance (inline styles, index keys). Deterministic coverage is the point.

---

### Phase 2: PATTERN GREP (semi-deterministic — catches ~30 issue types)

**Goal:** Run a fixed set of anti-pattern regexes targeting RN-specific issues that ESLint rules don't cover. Each grep produces candidates the agent triages.

Run these grep patterns across the project source:

| Pattern | What to grep | What it catches | Triage |
| ------- | ------------ | --------------- | ------ |
| Empty catch blocks | `catch\s*\(` with empty or comment-only bodies | Swallowed errors — silent failures hide bugs | Agent reviews each: add proper error handling or at minimum `console.error` |
| Unnecessary wrappers | `padding:\s*0` in StyleSheet definitions | `View` wrappers with `padding: 0` that do nothing | Agent checks if the wrapping View has any styling effect; remove if not |
| ScrollView + .map | `<ScrollView` near `.map(` (within ~20 lines) | Non-virtualized lists — renders all items regardless of viewport | Flag for `FlatList` / `FlashList` conversion |
| Unused state | `useState` where the setter is called but value never appears in JSX or props | State variables that are set but never rendered (counters, timestamps) | Grep for `set[A-Z]\w+` calls, check if corresponding value has JSX reference |
| Unbounded state growth | `...prev` spreads in `setState` without `.slice()` or size limit | Arrays/objects that grow without bound on every update | Agent checks if there's a cap; add `.slice(-N)` if missing |
| useNativeDriver: false | `useNativeDriver:\s*false` or missing `useNativeDriver` in Animated calls | Animations running on JS thread instead of native | Switch to `useNativeDriver: true` where possible (transform/opacity only) |
| Large image requires | `require\(.*\.(png\|jpg\|jpeg)` for images over reasonable size | Bundled large images that should be lazy-loaded or resized | Flag for review — consider progressive loading or CDN |

**Procedure:**

1. Run each grep pattern across the project's source directories (typically `src/`, `app/`, or project root).
2. Collect results as `file:line → pattern → matched text`.
3. Triage each candidate — not every match is a real issue. The grep finds candidates; the agent decides.
4. Group results by file for efficient fixing.

---

### Phase 3: SEMANTIC SWEEP (agent-driven — catches ~20 issue types)

**Goal:** Issues that require understanding code context, not just pattern matching. The agent must reason about each case, but uses a checklist to ensure nothing is skipped.

Work through each checklist item systematically. Do not skip items because they "probably don't apply."

#### 3a. Missing React.memo

For every exported function component:
- Is it rendered inside a list, a frequently-updating parent, or a context consumer?
- If yes and the component receives stable props, wrap in `React.memo`.
- **Skip if React Compiler is active** — check `react-profiler-analyze` meta for `reactCompilerEnabled`.

#### 3b. Sequential fetches → Promise.all

Grep for `await` inside `for`/`forEach` loops, and for sequential `await` calls that could be parallelized:
- Pattern: multiple `await fetch(...)` or `await api.get(...)` calls in sequence
- Fix: wrap independent calls in `Promise.all([...])`.

#### 3c. Missing cleanup in useEffect

Grep for `setInterval`, `setTimeout`, `addEventListener`, `.subscribe(`, `.on(` inside `useEffect` bodies:
- For each match, verify the useEffect returns a cleanup function that cancels/removes the subscription.
- Missing cleanup = memory leak + stale state updates on unmounted components.

#### 3d. Exhaustive deps (from Phase 1)

Process the `react-hooks/exhaustive-deps` findings collected in Phase 1:
- For each, read the hook body and determine the correct dependency array.
- Some "missing" deps are intentional (e.g., refs, dispatch functions). Use judgment.

#### 3e. Monolithic context

Flag but do not auto-fix:
- Contexts that combine unrelated state (e.g., user preferences + API cache + UI state in one provider).
- Consumers that destructure only one field but re-render when any field changes.
- Report these as architectural recommendations. Splitting contexts is a refactor, not a quick fix.

#### 3f. Unnecessary re-renders from context

For components using `useContext`:
- Check if the component uses all fields from the context, or only a subset.
- If only a subset: recommend selector pattern or context splitting.

---

### Phase 4: VISUAL VERIFICATION (argent's unique advantage)

**Goal:** Use the simulator and profiler to discover issues that static analysis can't find, and to verify fixes from Phases 1–3.

**Key insight: Profile for discovery, not just verification.** The profiler should be used to find the worst offenders visually — jank, re-renders, memory leaks — then cross-reference with remaining unfixed issues.

#### 4a. Performance baseline

1. Load `react-native-profiler` skill.
2. Start dual profiling: `react-profiler-start` + `ios-profiler-start` in parallel.
3. Exercise the app through key user flows (navigation, scrolling, data loading).
4. Stop profiling, run `react-profiler-analyze` + `ios-profiler-analyze` + `profiler-combined-report`.
5. Record baseline metrics: total render time, hot commit count, native hang count.

#### 4b. Discovery from profiling

Use profiling results to discover issues static analysis missed:
- Components with high `normalizedRenderCount` that weren't flagged in Phases 1–3.
- Native-layer bottlenecks (bridge serialization, layout thrashing) invisible to JS analysis.
- Network waterfalls visible in `view-network-logs` that cause render stalls.

#### 4c. Fix and re-measure

Apply fixes from all phases, starting with the highest-impact issues. After each fix:
1. Re-run `react-profiler-renders` for a quick spot-check.
2. For major fixes, do a full profiling cycle to confirm improvement.
3. **One fix per measure cycle** — never batch multiple fixes before re-measuring.

#### 4d. Final verification

After all fixes are applied:
1. Full profiling cycle on the same user flows as baseline.
2. Compare before/after metrics.
3. Run the app through `test-ui-flow` to verify no regressions.

---

## 3. Fix Reference

Match findings from any phase to the appropriate fix:

| Finding | Fix | Detail |
| ------- | --- | ------ |
| Re-renders with same props | `React.memo(Comp)` | **Skip if React Compiler active** — `react-profiler-analyze` reports compiler status per component |
| Expensive recomputation / unstable callbacks | `useMemo(fn, [deps])` / `useCallback(fn, [deps])` | `useCallback` must pair with `React.memo` on child |
| Inline objects/arrays in JSX | `StyleSheet.create()` / module const | New ref every render breaks shallow equality |
| Index as key in lists | Stable unique ID as key | `key={index}` breaks reconciliation on insert/delete/reorder |
| List jank | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` | Or `@shopify/flash-list` with `estimatedItemSize` |
| ScrollView with .map() | Convert to `FlatList` / `FlashList` | ScrollView renders all items; FlatList virtualizes |
| JS-thread animation jank | `useNativeDriver: true` or `react-native-reanimated` | `useNativeDriver` only for `transform`/`opacity` |
| Heavy work during transitions | `InteractionManager.runAfterInteractions()` | Defer until animation completes |
| Slow startup | Hermes + inline requires in `metro.config.js` | Lazy `require()` for heavy modules |
| Redundant, heavy, unoptimized or n+1 network calls | `view-network-logs` → `view-network-request-details` | Batch, debounce, or cache at data layer |
| Swallowed errors (empty catch) | Add proper error handling | At minimum `console.error(err)` — silent failures hide real bugs |
| Missing useEffect cleanup | Return cleanup function | Cancel timers, remove listeners, abort fetches on unmount |
| Unused state variables | Remove the `useState` call | State that's set but never rendered is wasted memory + renders |
| Unbounded state growth | Add `.slice(-N)` or size cap | Arrays that grow on every update leak memory |
| Missing hook dependencies | Add correct deps to array | Stale closures cause subtle bugs; `react-hooks/exhaustive-deps` catches these |
| Sequential awaits | `Promise.all([...])` | Parallelize independent async calls |
| Monolithic context | Split into focused contexts | Flag as architectural recommendation — not a quick fix |
| TypeScript `any` | Add proper types | Prevents optimization and masks type errors |

---

## 4. App-Wide Optimization

When optimizing the entire app, **dispatch parallel sub-agents** — one per phase or per feature area.

1. **Phase 1 + 2 in parallel** — Lint sweep and pattern grep can run concurrently across the full codebase. Merge results into a single prioritized issue list.
2. **Phase 3 per feature** — Spawn one sub-agent per major feature/module for the semantic sweep. Each agent works through the full checklist (§3a–3f) for its assigned files.
3. **Merge and prioritize** — Combine all findings from Phases 1–3, ranked by severity.
4. **Phase 4** — Profile the top offending screens/flows. Cross-reference profiling data with static findings.
5. **Fix top-down** — Apply fixes starting from worst offender, re-measure after each.

Use `react-profiler-renders` as a live pre-scan to validate static findings against runtime behavior.

---

## Related Skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Full React profiler workflow: measure → analyze → repeat |
| `ios-profiler` | Native iOS profiling (CPU hotspots, UI hangs, memory leaks) via Instruments |
| `react-native-app-workflow` | Build/run app, Metro, reload after changes |
| `metro-debugger` | Breakpoints, stepping, JS pause/resume — for correctness issues found during optimization |
| `test-ui-flow` | Verify optimized flows still work |
| `simulator-interact` | Navigate and interact with the simulator to trigger code paths for profiling |
