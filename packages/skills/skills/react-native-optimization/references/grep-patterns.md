# Phase 2: Grep Patterns

Run these regex patterns across the project source directories.
Each grep produces candidates — not every match is a real issue.
The agent triages each one.

## Patterns

### Empty catch blocks (swallowed errors)
```
catch\s*\(
```
Look for empty or comment-only bodies. Add proper error handling
or at minimum `console.error(err)`.

### Unnecessary wrappers
```
padding:\s*0
```
In StyleSheet definitions. Check if the wrapping View has any
styling effect — remove if it does nothing.

### ScrollView + .map() (non-virtualized lists)
```
<ScrollView
```
Within ~20 lines of `.map(`. Flag for FlatList/FlashList conversion.

### Unused state variables
```
useState
```
Find `set[A-Z]\w+` calls where the corresponding value never
appears in JSX or props. Common: renderCount, lastComputed,
refreshCount, lastRefresh.

### Unbounded state growth
```
\.\.\.prev
```
In setState callbacks without `.slice()` or size limit.
Arrays that grow every update leak memory.

### useNativeDriver: false
```
useNativeDriver:\s*false
```
Or missing `useNativeDriver` in Animated calls.
Switch to `true` where possible (transform/opacity only).

### Large bundled images
```
require\(.*\.(png|jpg|jpeg)
```
Flag for review — consider progressive loading or CDN.

## Procedure

1. Run each pattern across `src/`, `app/`, or project root.
2. Collect: `file:line -> pattern -> matched text`.
3. Triage each candidate — agent decides if it's a real issue.
4. Group results by file for efficient fixing.
