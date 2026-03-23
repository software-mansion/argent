# Phase 3: Semantic Sweep

Work through each item. Do not skip.

## Checklist

### Missing React.memo
For every exported function component rendered in a list, frequently-updating parent, or context consumer — wrap in `React.memo` if props are stable.
Skip if React Compiler is active.

### Sequential fetches
Grep for `await` inside loops and sequential `await` calls.
Wrap independent calls in `Promise.all`.

### Missing useEffect cleanup
Grep for `setInterval`, `setTimeout`, `addEventListener`, `.subscribe(`, `.on(` inside `useEffect`.
Verify each returns a cleanup function.

### Exhaustive deps (from Phase 1)
Process `react-hooks/exhaustive-deps` findings.
Some "missing" deps are intentional (refs, dispatch). Use judgment.

### Monolithic context
Flag but do NOT auto-fix. Report as architectural recommendation:
- Contexts combining unrelated state
- Consumers using only a subset of fields
