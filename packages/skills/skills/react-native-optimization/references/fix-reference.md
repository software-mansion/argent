# Fix Reference

Match findings from any phase to the appropriate fix.

| Finding | Fix | Detail |
| ------- | --- | ------ |
| Re-renders, same props | `React.memo(Comp)` | Skip if React Compiler active |
| Expensive recomputation | `useMemo(fn, [deps])` | Pair `useCallback` with `React.memo` on child |
| Inline objects/arrays in JSX | `StyleSheet.create()` / module const | New ref every render breaks shallow equality |
| Index as key in lists | Stable unique ID as key | Breaks reconciliation on insert/delete/reorder |
| List jank | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize` | Or `@shopify/flash-list` with `estimatedItemSize` |
| ScrollView + .map() | `FlatList` / `FlashList` | ScrollView renders all items; FlatList virtualizes |
| JS-thread animation | `useNativeDriver: true` / Reanimated | `useNativeDriver` only for transform/opacity |
| Heavy work during transitions | `InteractionManager.runAfterInteractions()` | Defer until animation completes |
| Slow startup | Hermes + inline requires | Lazy `require()` for heavy modules |
| Redundant network calls | Batch, debounce, or cache | Use `view-network-logs` to identify |
| Empty catch blocks | Add error handling | At minimum `console.error(err)` |
| Missing useEffect cleanup | Return cleanup function | Cancel timers, remove listeners on unmount |
| Unused state variables | Remove the `useState` | State set but never rendered wastes renders |
| Unbounded state growth | `.slice(-N)` or size cap | Arrays growing every update leak memory |
| Missing hook deps | Add correct deps to array | `exhaustive-deps` catches these |
| Sequential awaits | `Promise.all([...])` | Parallelize independent async calls |
| Monolithic context | Split into focused contexts | Flag as architectural rec, not quick fix |
| TypeScript `any` | Add proper types | Prevents optimization, masks errors |

## Tools for verification

| Tool | Purpose |
| ---- | ------- |
| `react-profiler-renders` | Quick render count spot-check |
| `react-profiler-analyze` | Full ranked report with hot commits |
| `react-profiler-component-source` | AST lookup: file, line, memo status |
| `debugger-evaluate` | Test fix live before editing source |
| `view-network-logs` | Spot slow/duplicate API calls |
| `profiler-cpu-query` | Drill into CPU hotspots |
| `ios-profiler-analyze` | Native CPU, hangs, memory leaks |
| `profiler-combined-report` | Cross-correlate React + iOS findings |
