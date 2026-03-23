# Phase 2: Grep Patterns

Run each pattern once across the source tree. Not every match is a real issue — triage each candidate.

## Patterns

| Pattern | Regex | Triage |
| ------- | ----- | ------ |
| Empty catch blocks | `catch\s*\([^)]*\)\s*\{[\s]*\}` | Catch with empty/whitespace-only body. Add error handling. |
| ScrollView + .map() | `<ScrollView` then `.map(` within ~20 lines (use `-A 20`) | Flag for FlatList/FlashList conversion |
| Unbounded state growth | `\.\.\.` inside setState callbacks | Check if array/object grows without `.slice()` or size cap |
| useNativeDriver: false | `useNativeDriver:\s*false` | Switch to `true` if animating non-layout properties |
| Large bundled images | Check `require(*.png/jpg)` file sizes on disk | Only flag files > 100KB; consider CDN or lazy loading |

## Procedure

1. Run each regex across `src/`, `app/`, or project root.
2. Collect: `file:line -> pattern -> matched text`.
3. Triage — agent decides if each match is a real issue.
4. Dispatch sub-agents to fix results — one per file with confirmed issues.
