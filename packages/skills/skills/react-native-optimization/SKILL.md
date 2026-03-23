---
name: react-native-optimization
description: Optimizes a React Native app via a 5-phase pipeline (lint sweep, pattern grep, semantic sweep, visual profiling, regression check). Entry-point for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to react-native-profiler for measurement.
---

## Rules

- **React Compiler**: if `react-profiler-analyze` reports `reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out via `react-profiler-fiber-tree` (absent `useMemoCache`).
- **Measure after high-impact fixes.** Architectural changes (context splits, FlatList conversions, memo additions) require re-profiling after each fix. Mechanical batch fixes (inline styles, index keys) can be applied together — re-profile once after the batch. Use programmatic (not e2e) performance measurements when possible — they are the most reliable and can be performed by sub-agents.
- **Profile for discovery, not only verification.** Use the profiler to find issues static analysis missed, not only to confirm fixes.
- **Sub-agent usage.** Phases 1–3 run centrally (one lint command, one grep pass), then sub-agents fix the *results* in parallel — one sub-agent per file with issues. Phase 3 dispatches one sub-agent per checklist item. Sub-agents CANNOT touch the simulator (it is a singleton) — all E2E interaction, profiling, and screenshot verification must happen in the main agent.
- **Fixes.** Consult [references/fix-reference.md](references/fix-reference.md) for the finding-to-fix table. It is the single source of truth for how to fix each issue.

## Pipeline

For full-app optimization, run all five phases in order.
For a single screen, start with a baseline profile (Phase 4), then scope Phases 1–3 to the screen's component tree, re-profile, then verify (Phase 5).

Copy this checklist into your TODO list:

```
Optimization Progress:
- [ ] Phase 1: Lint sweep (deterministic)
- [ ] Phase 2: Pattern grep (semi-deterministic)
- [ ] Phase 3: Semantic sweep (agent-driven)
- [ ] Phase 4: Visual profiling (measure + verify)
- [ ] Phase 5: Verify all screens/flows are not crashing
```

### Phase 1 — Lint sweep

Run ESLint once at the project root, parse JSON output into a hit list.
See [references/lint-rules.md](references/lint-rules.md) for ruleset and procedure.

### Phase 2 — Pattern grep

Run each regex pattern once across the source tree. Triage candidates.
See [references/grep-patterns.md](references/grep-patterns.md) for patterns.

### Phase 3 — Semantic sweep

Work through a checklist requiring code understanding. Depends on Phase 1 output (exhaustive-deps findings).
See [references/semantic-checklist.md](references/semantic-checklist.md) for full checklist.

### Phase 4 — Visual profiling

1. Load `react-native-profiler` skill, start dual profiling
2. Exercise key user flows (navigate screens the user specified, or all major flows)
3. Analyze with `react-profiler-analyze` + `ios-profiler-analyze`
4. Cross-reference profiling results with Phase 1–3 findings
5. Fix highest-impact issues. Re-profile after architectural changes; batch mechanical fixes.

### Phase 5 — Verify no regressions

Navigate every screen and UI flow within scope, confirm each renders without errors. If no scope was specified, verify the entire app — cover all reachable screens via `simulator-interact`. Use `debugger-log-registry` to check for runtime errors and take screenshots to check for red/yellow error screens. This phase runs in the main agent only.

## App-wide optimization

1. **Phase 1+2** — run lint and grep centrally (one command each), collect all results
2. **Dispatch sub-agents** — one per file with issues, to apply fixes in parallel
3. **Phase 3** — one sub-agent per checklist item for semantic sweep
4. **Merge** findings, rank by severity
5. **Phase 4+5** — main agent profiles top offending screens, then verifies nothing crashes
6. **Fix top-down** — worst offender first, re-profile after architectural changes
