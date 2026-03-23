---
name: react-native-optimization
description: Optimizes a React Native app via a 4-phase pipeline (lint sweep, pattern grep, semantic sweep, visual profiling). Entry-point for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to react-native-profiler for measurement.
---

## Rules

- **React Compiler**: if `react-profiler-analyze` reports `reactCompilerEnabled: true`, do NOT propose `useCallback`/`useMemo`/`React.memo` unless you confirmed compiler bail-out via `react-profiler-fiber-tree` (absent `useMemoCache`).
- **One fix per measure cycle.** Fix → re-profile → confirm improvement. NEVER BATCH. Use programatic (not e2e) performence measurements when possible - they are the most reliable and can be performed by sub-agents.
- **Profile for discovery, not only verification.** Use the profiler to find issues static analysis missed, not only to confirm fixes.

## Pipeline

For full-app optimization, run all four phases in order.
For a single screen, start at Phase 4 and scope Phases 1–3 to relevant files.

Copy this checklist into your TODO list:

```
Optimization Progress:
- [ ] Phase 1: Lint sweep (deterministic)
- [ ] Phase 2: Pattern grep (semi-deterministic)
- [ ] Phase 3: Semantic sweep (agent-driven)
- [ ] Phase 4: Visual profiling (measure + verify)
```

### Phase 1 — Lint sweep

Run ESLint with RN-specific rules, parse JSON output into a hit list, process each hit individually.
See [references/lint-rules.md](references/lint-rules.md) for ruleset and procedure.

### Phase 2 — Pattern grep

Run fixed regex patterns for anti-patterns ESLint can't catch. Triage each candidate.
See [references/grep-patterns.md](references/grep-patterns.md) for patterns.

### Phase 3 — Semantic sweep

Work through a checklist that requires code understanding:
missing `React.memo`, sequential `await` → `Promise.all`, missing `useEffect` cleanup, incorrect hook deps, monolithic contexts.
See [references/semantic-checklist.md](references/semantic-checklist.md) for full checklist.

### Phase 4 — Visual profiling

1. Load `react-native-profiler` skill, start dual profiling
2. Exercise key user flows
3. Analyze with `react-profiler-analyze` + `ios-profiler-analyze`
4. Cross-reference profiling results with Phase 1–3 findings
5. Fix highest-impact issues. Re-profile after each fix.

## Fix reference

See [references/fix-reference.md](references/fix-reference.md) for the full table.

| Finding | Fix |
| ------- | --- |
| Re-renders, same props | `React.memo` (skip if Compiler active) |
| Inline styles/objects in JSX | `StyleSheet.create()` / module const |
| Index as list key | Stable unique ID |
| ScrollView + `.map()` | `FlatList` / `FlashList` |
| Empty catch blocks | Proper error handling |
| Missing useEffect cleanup | Return cleanup function |
| Sequential awaits | `Promise.all` |
| JS-thread animation | `useNativeDriver: true` / Reanimated |
| Slow network | `view-network-logs` → batch/debounce/cache |

## App-wide optimization

Dispatch parallel sub-agents:
1. **Phase 1+2 in parallel** across full codebase
2. **Phase 3** — one sub-agent per feature/module
3. **Merge** findings, rank by severity
4. **Phase 4** — profile top offending screens
5. **Fix top-down** — worst offender first, re-measure each

Use `react-profiler-renders` as a live pre-scan to validate static findings against runtime behavior.
