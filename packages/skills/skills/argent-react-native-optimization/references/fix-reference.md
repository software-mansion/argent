# Fix Reference

Match profiler findings and semantic sweep results to concrete fixes. With React Compiler active, skip the first three rows.

| Finding                                      | Fix                                                                           | Detail                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Re-renders with same props                   | `React.memo(Comp)`                                                            | Only where the props really are equal between renders                        |
| Expensive recomputation / unstable callbacks | `useMemo(fn, [deps])` / `useCallback(fn, [deps])`                             | `useCallback` must pair with `React.memo` on child; alone it has no effect   |
| Inline objects/arrays in JSX                 | `StyleSheet.create()` / module-level const                                    | New reference every render breaks shallow equality                           |
| List jank                                    | `removeClippedSubviews`, `maxToRenderPerBatch`, `windowSize`, `getItemLayout` | Or migrate to `@shopify/flash-list` (v2 needs the New Architecture)          |
| JS-thread animation jank                     | `useNativeDriver: true` or `react-native-reanimated`                          | `useNativeDriver` can't animate layout props (width, height, margins, …)     |
| Heavy work during transitions                | `requestIdleCallback()`                                                       | Runs the work when the JS thread is idle; `InteractionManager` is deprecated |
| Slow startup                                 | Defer heavy imports (lazy `require()`)                                        | Check inline requires in the Metro config (on in bare RN, off in Expo)       |
| Redundant, heavy, or n+1 network calls       | `view-network-logs` → `view-network-request-details`                          | Batch, debounce, or cache at the data layer                                  |
