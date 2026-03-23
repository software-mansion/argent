# Fix Reference

| Finding | Fix |
| ------- | --- |
| Re-renders, same props | `React.memo` (skip if Compiler active) |
| Expensive recomputation | `useMemo` / `useCallback` (pair with `React.memo` on child) |
| Inline objects/arrays in JSX | `StyleSheet.create()` / module const |
| Index as key | Stable unique ID |
| List jank | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` (only if fixed height), or `@shopify/flash-list` |
| ScrollView + .map() | `FlatList` / `FlashList` |
| JS-thread animation | `useNativeDriver: true` / Reanimated. Supports all non-layout properties — cannot animate width, height, margin, padding, flex. |
| Heavy work during transitions | `InteractionManager.runAfterInteractions()` |
| Slow startup | Hermes + inline requires in `metro.config.js`, `React.lazy` with Suspense for code splitting |
| Slow/redundant network | Batch, debounce, or cache. Use `view-network-logs` → `view-network-request-details` to identify. |
| Empty catch blocks | Add error handling (`console.error` at minimum) |
| Missing useEffect cleanup | Return cleanup function (cancel timers, remove listeners) |
| Unused state | Remove the `useState` call |
| Unbounded state growth | `.slice(-N)` or size cap |
| Missing hook deps | Add correct deps per `exhaustive-deps` |
| Sequential awaits | `Promise.all` |
| Monolithic context | Split into focused contexts (architectural rec, not quick fix) |
| Navigation jank | `react-native-screens`, `enableFreeze()`, lazy screen loading |
| Image performance | `FastImage` or equivalent, proper sizing, caching strategy |
| console.log in production | Strip with `babel-plugin-transform-remove-console` |
