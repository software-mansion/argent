---
name: react-native-optimization
description: Optimizes a React Native app via a 4-phase pipeline (lint sweep, semantic sweep, visual profiling, regression check). Entry-point for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to react-native-profiler for measurement.
---

## Rules

- Do not apply shotgun optimizations. Measure first, define what "good enough" looks like (target metric + threshold), fix the top offender, re-measure honestly.

- **Quick scan** — `react-profiler-renders` for a live render count table. Identifies hot components instantly.
- **Deep measure** — load `react-native-profiler` skill. `react-profiler-start` → interact → `react-profiler-stop` → `react-profiler-analyze`.
- **Inspect** — `react-profiler-component-source` per finding. `react-profiler-fiber-tree` to trace component ancestry and render cost.
- **Verify correctness** - before attempting fixing, recollect the information from steps &1, &2, &3 and make logical conclusion whether the approach is worth undertaking
- **Fix** — apply one fix from §3. Validate with `debugger-evaluate` before committing.
- **Re-measure** — re-run step 1 or 2. Report whether the target metric improved, regressed, or stayed flat. Check whether the fix introduced regressions in other areas (e.g., fewer re-renders but higher CPU, or new jank in a different screen). If no net benefit or unacceptable tradeoffs, revert. 
- **Profile for discovery, not only verification.** Use the profiler to find issues static analysis missed, not only to confirm fixes.
- **One fix per cycle** — never batch. When the measurement involves simulator interaction, record the interaction as a flow (`create-flow` skill) before the first run so all subsequent cycles replay identical steps. If a recorded flow breaks after applying a fix (e.g., UI layout changed), follow `create-flow` skill §10 to repair the flow rather than silently discarding it.
- **React Compiler**: if `react-profiler-analyze` reports `reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out via `react-profiler-fiber-tree` (absent `useMemoCache`).
- **Measure after high-impact fixes.** Architectural changes (context splits, FlatList conversions, memo additions) require re-profiling after each fix. Mechanical batch fixes (inline styles, index keys) can be applied together - re-profile once after the batch. Use programmatic (not e2e) performance measurements when possible - they are the most reliable and can be performed by sub-agents.
- **Sub-agent usage.** Phase 1 runs centrally (one lint command), then sub-agents fix the *results* in parallel - one sub-agent per file with issues. Phase 2 dispatches one sub-agent per checklist item. Sub-agents CANNOT touch the simulator (it is a singleton) - all E2E interaction, profiling, and screenshot verification must happen in the main agent.

## Pipeline

For full-app optimization, run all four phases in order.
For a single screen, start with a baseline profile (Phase 3), then scope Phases 1–2 to the screen's component tree, re-profile, then verify (Phase 4).

Copy this checklist into your TODO list:

```
Optimization Progress:
- [ ] Phase 1: Lint sweep (deterministic)
- [ ] Phase 2: Semantic sweep (agent-driven)
- [ ] Phase 3: Visual profiling (measure + verify)
- [ ] Phase 4: Verify all screens/flows are not crashing
```

### Phase 1: Lint sweep

Run ESLint once at the project root with a comprehensive RN performance ruleset.
See [references/lint-rules.md](references/lint-rules.md) for ruleset and procedure.

### Phase 2: Semantic sweep

Review each area of the codebase requiring judgment - memoization, list rendering, animations, async patterns, effect cleanup, state hygiene, context architecture.
See [references/semantic-checklist.md](references/semantic-checklist.md) for full checklist.

### Phase 3: Visual profiling

1. Load `react-native-profiler` skill, start dual profiling
2. Exercise key user flows (navigate screens the user specified, or all major flows)
3. Analyze with `react-profiler-analyze` + `ios-profiler-analyze`
4. Cross-reference profiling results with Phase 1–2 findings
5. Fix highest-impact issues. Re-profile after architectural changes; batch mechanical fixes.

### Phase 4: Verify no regressions

Navigate every screen and UI flow within scope, confirm each renders without errors. If no scope was specified, verify the entire app - cover all reachable screens via `simulator-interact`. Use `debugger-log-registry` to check for runtime errors and take screenshots to check for red/yellow error screens. This phase runs in the main agent only.

## App-wide optimization

1. **Phase 1**: run lint centrally (one command), collect all results
2. **Dispatch sub-agents**: one per file with issues, to apply fixes in parallel
3. **Phase 2**: one sub-agent per checklist item for semantic sweep
4. **Merge** findings, rank by severity
5. **Phase 3+4**: main agent profiles top offending screens, then verifies nothing crashes
6. **Fix top-down**: worst offender first, re-profile after architectural changes

Use `react-profiler-renders` as a live pre-scan to validate static findings against runtime behavior.
