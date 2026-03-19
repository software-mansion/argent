---
name: react-native-optimization
description: Optimize a React Native app for performance, bundle size, and runtime efficiency. Use when reducing app size, improving startup time, eliminating unnecessary re-renders, optimizing images, lists, navigation, or applying production-ready performance patterns.
---

## 1. Prerequisites

Requires a working React Native project. Most techniques are code-level — no MCP tools needed unless profiling. For profiling-guided optimization, use the `react-native-profiler` skill first to identify bottlenecks, then return here to apply fixes.

**Rule: Profile before optimizing.** Do not apply shotgun optimizations. Measure first, fix the top offender, re-measure.

---

## 2. Optimization Tools

### 2.1 Re-render Prevention

| Tool | Why | How |
| ---- | --- | --- |
| `React.memo()` | Skips re-render when props are shallow-equal. Most impactful on leaf components rendered inside lists or frequently-updating parents. | Wrap component: `export default React.memo(MyComponent)`. Add custom comparator for complex props: `React.memo(Comp, (prev, next) => prev.id === next.id)`. |
| `useMemo` | Caches expensive derived values. Prevents recomputation on every render. | `const sorted = useMemo(() => items.sort(compareFn), [items])`. Only use when computation is measurably expensive — not for trivial expressions. |
| `useCallback` | Stabilizes function references passed as props. Without it, child `React.memo` wrappers break because a new function reference is created each render. | `const onPress = useCallback(() => doThing(id), [id])`. Always pair with `React.memo` on the receiving child — alone it does nothing. |

**React Compiler rule:** If `profiler-analyze` reports `reactCompilerEnabled: true`, skip manual `useMemo`/`useCallback`/`React.memo` unless `profiler-fiber-tree` confirms the compiler bailed out (no `useMemoCache` on that component).

### 2.2 List Performance

| Tool | Why | How |
| ---- | --- | --- |
| `FlashList` | Drop-in `FlatList` replacement. Recycles cells instead of unmounting/remounting — 5-10x faster on long lists. | `npm install @shopify/flash-list`. Replace `<FlatList>` with `<FlashList>` and add `estimatedItemSize={N}`. Must set `estimatedItemSize` or performance regresses. |
| `FlatList` tuning | When migrating to FlashList is not possible, tuning existing FlatList props reduces jank significantly. | Set `removeClippedSubviews={true}`, `maxToRenderPerBatch={10}`, `windowSize={5}`, `initialNumToRender={10}`. Add `getItemLayout` if items have fixed height — eliminates measurement passes. |
| `keyExtractor` | Prevents full list re-render on data change. Without stable keys, React unmounts and remounts every cell. | `keyExtractor={(item) => item.id}`. Never use array index — it breaks recycling on reorder/insert/delete. |

### 2.3 Image Optimization

| Tool | Why | How |
| ---- | --- | --- |
| `react-native-fast-image` | Replaces `<Image>` with native caching, priority loading, and progressive rendering. Stock `<Image>` has no disk cache and re-downloads on remount. | `npm install react-native-fast-image`. Replace `<Image source={{uri}}>` with `<FastImage source={{uri, priority: FastImage.priority.normal}} resizeMode={FastImage.resizeMode.cover} />`. |
| Image preloading | Eliminates visible loading flicker on navigation. | `FastImage.preload([{uri: 'https://...'}])` before navigating. For stock Image: `Image.prefetch(uri)`. |
| Correct `resizeMode` | Oversized images waste GPU memory and cause jank. | Always set explicit `width`/`height` on image components. Use `resizeMode="cover"` or `"contain"` — never stretch. Serve images at display size from backend when possible. |

### 2.4 Navigation Optimization

| Tool | Why | How |
| ---- | --- | --- |
| `react-native-screens` | Detaches off-screen screens from the view hierarchy. Without it, all screens in the stack remain mounted and consume memory/CPU. | `npm install react-native-screens` then add `enableScreens(true)` in app entry point before any navigation code. Verify with `react-navigation` v5+ — it auto-integrates. |
| Lazy screen loading | Screens with heavy content delay initial navigation render. | Use `React.lazy()` + `Suspense` for screens not on the initial route: `const Settings = React.lazy(() => import('./Settings'))`. |
| `detachInactiveScreens` | Stack and tab navigators keep all visited screens alive by default. | Set `detachInactiveScreens={true}` on tab navigators. For stacks, `react-native-screens` handles this automatically when enabled. |

### 2.5 Startup Time

| Tool | Why | How |
| ---- | --- | --- |
| Hermes | Pre-compiled bytecode eliminates JS parse time on launch. Startup 30-50% faster. | Verify enabled: `android/gradle.properties` should have `hermesEnabled=true`; iOS: check Podfile for `hermes_enabled => true`. RN 0.70+ has Hermes on by default. |
| Lazy `require()` | Defers module initialization until first use. Reduces main bundle parse time. | Replace top-level `import HeavyLib from 'heavy-lib'` with `const HeavyLib = require('heavy-lib')` inside the function that uses it. For inline requires at scale, enable `metro.config.js`: `transformer: { getTransformOptions: () => ({ transform: { inlineRequires: true } }) }`. |
| Reduce splash-screen work | Heavy API calls or synchronous storage reads during mount block the first frame. | Move initialization to `useEffect` or `InteractionManager.runAfterInteractions()`. Show skeleton screens instead of blocking. |

### 2.6 Bundle Size

| Tool | Why | How |
| ---- | --- | --- |
| `react-native-bundle-visualizer` | Generates a treemap of the JS bundle to find bloated dependencies. Without visibility, you optimize blind. | `npx react-native-bundle-visualizer`. Opens an interactive treemap. Target the largest non-framework nodes first. |
| Import cost audit | Named imports from barrel files (`import { x } from 'huge-lib'`) pull the entire module unless tree-shaking is configured. | Replace `import { debounce } from 'lodash'` with `import debounce from 'lodash/debounce'`. Same for `date-fns`, `ramda`, etc. Use `babel-plugin-module-resolver` for enforced deep imports at scale. |
| Remove unused deps | Dead dependencies inflate install size and sometimes bundle size. | `npx depcheck` to find unused packages. Verify each before removing — some are native-only and don't appear in JS imports. |
| ProGuard / R8 (Android) | Strips unused Java/Kotlin code and resources in release builds. | Ensure `android/app/build.gradle` has `minifyEnabled true` and `shrinkResources true` in the `release` buildType. |

### 2.7 Runtime & Animation

| Tool | Why | How |
| ---- | --- | --- |
| `InteractionManager` | Defers expensive work until animations complete. Running heavy computation mid-transition causes dropped frames. | `InteractionManager.runAfterInteractions(() => { loadData(); })`. Use in screen `useEffect` callbacks. |
| `useNativeDriver` | Offloads animation to the UI thread. JS-driven animations block the JS thread and cause jank on simultaneous interactions. | `Animated.timing(val, { toValue: 1, useNativeDriver: true })`. Only works for `transform` and `opacity` — not `height`, `width`, `backgroundColor`. |
| `react-native-reanimated` | Full native-thread animation library. Supports layout animations, shared element transitions, gesture-driven animations that `Animated` cannot handle. | `npm install react-native-reanimated`. Configure babel plugin: `plugins: ['react-native-reanimated/plugin']` (must be last). Use `useSharedValue` + `useAnimatedStyle` instead of `Animated.Value`. |

---

## 3. Optimization Workflow

1. **Profile** — use `react-native-profiler` skill to get a ranked issue report.
2. **Identify category** — match top findings to sections above (re-renders → §2.1, list jank → §2.2, etc.).
3. **Apply one fix** — make the smallest targeted change.
4. **Re-profile** — confirm `totalRenderMs` or startup time improved.
5. **Repeat** — move to next finding. Stop when gains are marginal.

**Do not batch multiple optimizations.** One fix per cycle ensures you know what helped.

---

## 4. Anti-Patterns to Flag

| Anti-pattern | Impact | Fix |
| ------------ | ------ | --- |
| Inline object/array props `style={{flex:1}}` | New reference every render, breaks `React.memo` | Extract to `StyleSheet.create()` or module-level const |
| Anonymous functions in JSX `onPress={() => ...}` | New reference every render | Extract to `useCallback` |
| `JSON.parse`/`JSON.stringify` in render | Blocks JS thread | Move to `useMemo` or pre-process outside render |
| Unkeyed or index-keyed lists | Full remount on data change | Add stable `keyExtractor` |
| Console.log in production | Synchronous I/O on JS thread | Strip with `babel-plugin-transform-remove-console` |

---

## Quick Reference

| Goal | Tool / Technique |
| ---- | ---------------- |
| Find bottlenecks | `react-native-profiler` skill |
| Visualize bundle | `react-native-bundle-visualizer` |
| Fix re-renders | `React.memo` + `useCallback` + `useMemo` |
| Fast lists | `FlashList` or tuned `FlatList` |
| Image caching | `react-native-fast-image` |
| Native animations | `react-native-reanimated` / `useNativeDriver` |
| Faster startup | Hermes + inline requires + lazy init |
| Smaller bundle | Deep imports, `depcheck`, ProGuard |
| Defer heavy work | `InteractionManager.runAfterInteractions` |
| Screen detach | `react-native-screens` + lazy routes |

---

## Related Skills

| Skill | When to use |
| ----- | ----------- |
| `react-native-profiler` | Measure before and after — profile-guided optimization |
| `react-native-app-workflow` | Build/run the app, Metro issues, reload after changes |
| `metro-debugger` | Evaluate JS in runtime, inspect components, set breakpoints |
| `test-ui-flow` | Verify optimized flows still work correctly |
