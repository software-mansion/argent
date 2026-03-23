# Phase 2: Grep Patterns

Run each pattern once across the source tree. Not every match is a real issue — triage each candidate. Consult fix-reference.md for how to fix confirmed issues.

## Patterns

| Pattern | Regex | Is it real? |
| ------- | ----- | ----------- |
| Empty catch blocks | `catch\s*\([^)]*\)\s*\{[\s]*\}` | Yes if body is empty/whitespace-only |
| ScrollView + .map() | `<ScrollView` then `.map(` within ~20 lines (use `-A 20`) | Yes if rendering a dynamic list |
| Unbounded state growth | `\.\.\.` inside setState callbacks | Only if array/object grows without bound |
| useNativeDriver: false | `useNativeDriver:\s*false` | Only if animating non-layout properties |
| Large bundled images | Check `require(*.png/jpg)` file sizes on disk | Only flag files > 100KB |
