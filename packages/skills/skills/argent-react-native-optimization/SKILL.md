---
name: argent-react-native-optimization
description: Optimizes a React Native app by profiling first to find real bottlenecks, then sweeping for mechanical issues. Entry-point for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to argent-react-native-profiler for measurement.
---

## Rules

- Do not apply shotgun optimizations. Measure first, define what "good enough" looks like (target metric + threshold), fix the top offender, re-measure honestly.
- **Profile for discovery, not only verification.** Use the profiler to find issues static analysis missed, not only to confirm fixes.
- **Verify before fixing:** recollect the evidence and conclude whether the fix is worth undertaking. Validate a fix with `debugger-evaluate` before committing it.
- **One fix per cycle for architectural changes.** Mechanical batch fixes (inline styles, index keys) can be grouped; re-profile once after the batch. When the measurement involves device interaction, record it as an e2e test (`argent-create-e2e` skill) before the first run so every cycle replays identical steps.
- **React Compiler**: if the profiler report shows React Compiler enabled, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed the compiler bailed out on that component (`react-profiler-fiber-tree` shows no `useMemoCache`).
- **Sub-agents**: Phases 1–2 dispatch sub-agents: one per file for lint results, one per checklist item for semantic. Sub-agents CANNOT touch the device - all profiling and E2E verification must happen in the main agent.

## Pipeline

**Lint and semantic sweeps catch deterministic issues cheaply. Profiling finds runtime bottlenecks that static analysis misses. Do both.**

Copy this checklist into your TODO list:

```
Optimization Progress:
- [ ] Phase 1: Lint sweep (deterministic: catch mechanical issues without a running app)
- [ ] Phase 2: Semantic sweep (judgment: memoization, lists, animations, etc.)
- [ ] Phase 3: Baseline profile (find real bottlenecks, fix top offenders)
- [ ] Phase 4: Verify no regressions (crashes, errors, red screens)
- [ ] Re-run lint to confirm the fixes added no new issues and none were missed
```

### Phase 1: Lint sweep

Run ESLint once at the project root with a comprehensive RN performance ruleset. Dispatch sub-agents to fix results: one per file, in parallel.
See [references/lint-rules.md](references/lint-rules.md) for ruleset and procedure.

### Phase 2: Semantic sweep

Review each area requiring judgment: memoization, list rendering, animations, async patterns, effect cleanup, state hygiene, context architecture. Dispatch one sub-agent per checklist item.
See [references/semantic-checklist.md](references/semantic-checklist.md) for full checklist.

### Phase 3: Profiling

1. For a quick look, `react-profiler-renders` gives a live render-count table without a session.
2. Load the `argent-react-native-profiler` skill and follow its workflow (React and native profiling together) on the key user flows: the screens the user named, or all major flows. It covers analysis, drill-down, and re-profiling after each fix.
3. Cross-reference the profiling results with the Phase 1–2 findings, and fix the highest-impact issues top-down. Re-profile after architectural changes; batch mechanical fixes.

### Phase 4: Verify no regressions

Navigate every screen and UI flow within scope (the entire app if no scope was given, via `argent-device-interact`) and confirm each renders without errors. Check `debugger-log-registry` for runtime errors (`Grep` its log file) and take screenshots to catch red/yellow error screens. Look for regressions the fixes introduced (e.g. fewer re-renders but higher CPU, or new jank on a different screen). Main agent only.
