# Phase 2: Grep Patterns

Run these across project source directories. Not every match is a real issue — triage each candidate.

## Patterns

| Pattern | Regex | Triage |
| ------- | ----- | ------ |
| Empty catch blocks | `catch\s*\(` with empty body | Add error handling |
| Unnecessary wrappers | `padding:\s*0` in StyleSheet | Check if wrapping View does anything |
| ScrollView + .map() | `<ScrollView` near `.map(` | Flag for FlatList conversion |
| Unused state | `useState` where value never in JSX | Remove the useState call |
| Unbounded growth | `\.\.\.prev` in setState without `.slice()` | Add size cap |
| useNativeDriver: false | `useNativeDriver:\s*false` | Switch to `true` if transform/opacity |
| Large bundled images | `require\(.*\.(png\|jpg\|jpeg)` | Consider CDN or lazy loading |

## Procedure

1. Run each pattern across `src/`, `app/`, or project root.
2. Collect: `file:line -> pattern -> matched text`.
3. Triage — agent decides if each match is a real issue.
4. Group results by file for efficient fixing.
