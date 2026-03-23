# Phase 1: Lint Rules

Run these before reading any code. Catches mechanical issues deterministically.

## Rules

| Rule | Catches |
| ---- | ------- |
| `react-native/no-inline-styles` | Inline `style={{}}` — new ref every render |
| `react/no-array-index-key` | `key={index}` — breaks reconciliation |
| `@typescript-eslint/no-explicit-any` | `any` types |
| `prefer-template` | String concat with `+` |
| `@typescript-eslint/no-unused-vars` | Unused variables |
| `react-hooks/exhaustive-deps` | Missing/incorrect hook deps |

## Procedure

1. Check if the project has an existing ESLint config.
2. Run each rule with `--format json`:
   ```bash
   npx eslint --no-eslintrc --rule '{rule}: error' \
     --format json {src_dir}
   ```
   Or use the project's config if it already includes these rules.
3. Parse output into: `file:line -> rule -> message`.
4. Process each hit. Skip intentional patterns (e.g. inline styles
   in one-off animations).
5. Collect `exhaustive-deps` hits for Phase 3 — they need semantic
   reasoning to determine correct dependencies.
