---
name: react-native-optimization
description: Optimize a React Native app using a 4-phase pipeline (lint, grep, semantic, profile). Entry-point for all performance work. Use when the app feels slow, user asks to optimize, fix re-renders, reduce jank, or improve startup. Delegates to react-native-profiler for measurement.
---

## Pipeline

Run all four phases in order for full-app optimization.
For a single screen, start at Phase 4 and scope Phases 1-3 to relevant files.

### Phase 1 — Lint sweep (deterministic)

Run ESLint with RN-specific rules. Parse JSON output into a hit list.
Process each hit — skip intentional patterns, fix the rest.
See `references/lint-rules.md` for the full ruleset and procedure.

### Phase 2 — Pattern grep (semi-deterministic)

Run fixed regex patterns for anti-patterns ESLint can't catch.
Each grep produces candidates the agent triages.
See `references/grep-patterns.md` for patterns and triage guidance.

### Phase 3 — Semantic sweep (agent-driven)

Work through a checklist requiring code understanding:
- Missing `React.memo` on list/context children
- Sequential `await` calls convertible to `Promise.all`
- Missing `useEffect` cleanup (timers, listeners, subscriptions)
- Incorrect hook dependency arrays (from Phase 1 `exhaustive-deps`)
- Monolithic contexts (flag, don't auto-fix)
See `references/semantic-checklist.md` for the full checklist.

### Phase 4 — Visual profiling (argent's advantage)

Profile for **discovery**, not just verification.
1. Load `react-native-profiler` skill
2. Start dual profiling (`react-profiler-start` + `ios-profiler-start`)
3. Exercise key user flows
4. Analyze: `react-profiler-analyze` + `ios-profiler-analyze`
5. Cross-reference profiling results with Phase 1-3 findings
6. Fix highest-impact issues first. **One fix per measure cycle.**
7. Re-profile to confirm improvement after each fix

## Fix reference

See `references/fix-reference.md` for the complete finding-to-fix table.

Quick lookup for common findings:

| Finding | Fix |
| ------- | --- |
| Re-renders with same props | `React.memo` (skip if Compiler active) |
| Inline styles in JSX | `StyleSheet.create()` / module const |
| Index as list key | Stable unique ID |
| ScrollView + `.map()` | Convert to `FlatList` / `FlashList` |
| Empty catch blocks | Add proper error handling |
| Missing useEffect cleanup | Return cleanup function |
| Sequential awaits | `Promise.all([...])` |
| JS-thread animation | `useNativeDriver: true` / Reanimated |

## App-wide optimization

Dispatch parallel sub-agents for coverage:
1. **Phase 1+2 in parallel** across full codebase
2. **Phase 3** — one sub-agent per feature/module
3. **Merge** all findings, rank by severity
4. **Phase 4** — profile top offending screens
5. **Fix top-down** — worst offender first, re-measure each

## Related skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Measure, analyze, repeat |
| `ios-profiler` | Native CPU hotspots, UI hangs, leaks |
| `react-native-app-workflow` | Build/run app, Metro, reload |
| `metro-debugger` | Breakpoints, stepping, JS evaluation |
| `test-ui-flow` | Verify flows still work after fixes |
| `simulator-interact` | Navigate app for profiling |
