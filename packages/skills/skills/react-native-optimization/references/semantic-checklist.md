# Phase 2: Semantic Sweep

Work through each item. Do not skip.
Depends on Phase 1 output — `exhaustive-deps` findings must be available.
Consult fix-reference.md for how to fix confirmed issues.

## Checklist

### Missing React.memo
Check every exported function component rendered in a list, frequently-updating parent, or context consumer. Skip if React Compiler is active.

### ScrollView + .map()
Grep for `<ScrollView` with `.map(` nearby. These should be FlatList/FlashList.

### Sequential fetches
Grep for `await` inside loops and sequential `await` calls that could be parallelized.

### Missing useEffect cleanup
Grep for `setInterval`, `setTimeout`, `addEventListener`, `.subscribe(`, `.on(` inside `useEffect`. Verify each returns a cleanup function.

### Unused state variables
Find `useState` calls where the value is set but never read in JSX or passed to children.

### Unbounded state growth
Look for spread patterns (`...prev`) in setState callbacks where arrays/objects grow without `.slice()` or size cap.

### useNativeDriver: false
Grep for `useNativeDriver:\s*false`. Switch to `true` if animating non-layout properties.

### Exhaustive deps (from Phase 1)
Process `react-hooks/exhaustive-deps` findings. Some "missing" deps are intentional (refs, dispatch). Use judgment.

### Monolithic context
Flag but do NOT auto-fix. Report as architectural recommendation.
