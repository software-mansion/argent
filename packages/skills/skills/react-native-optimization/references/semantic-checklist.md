# Phase 3: Semantic Sweep Checklist

These issues require understanding code context.
Work through each item systematically — do not skip items.

## 3a. Missing React.memo

For every exported function component:
- Is it rendered in a list, frequently-updating parent, or
  context consumer?
- If yes and props are stable, wrap in `React.memo`.
- **Skip if React Compiler active** — check `react-profiler-analyze`
  meta for `reactCompilerEnabled`.

## 3b. Sequential fetches

Grep for `await` inside `for`/`forEach` loops, and for
sequential `await` calls that could be parallelized.
Fix: wrap independent calls in `Promise.all([...])`.

## 3c. Missing useEffect cleanup

Grep for these inside `useEffect` bodies:
- `setInterval`, `setTimeout`
- `addEventListener`, `.subscribe(`, `.on(`

Verify each useEffect returns a cleanup function that
cancels/removes the subscription. Missing cleanup = memory leak.

## 3d. Exhaustive deps (from Phase 1)

Process `react-hooks/exhaustive-deps` findings from Phase 1.
Read each hook body, determine correct dependency array.
Some "missing" deps are intentional (refs, dispatch). Use judgment.

## 3e. Monolithic context

Flag but do NOT auto-fix:
- Contexts combining unrelated state (user prefs + API cache +
  UI state in one provider)
- Consumers destructuring one field but re-rendering on any change

Report as architectural recommendations.

## 3f. Unnecessary context re-renders

For components using `useContext`:
- Check if component uses all context fields or only a subset.
- If subset: recommend selector pattern or context splitting.
