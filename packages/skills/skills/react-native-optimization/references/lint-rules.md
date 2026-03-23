# Phase 1: Lint Rules

Run ESLint with these rules before reading any code.
This catches ~120 mechanical issues deterministically.

## Rules

| Rule | What it catches |
| ---- | --------------- |
| `react-native/no-inline-styles` | `style={{}}` in JSX — new ref every render |
| `react/no-array-index-key` | `key={index}` — breaks reconciliation |
| `@typescript-eslint/no-explicit-any` | `any` types — masks errors |
| `prefer-template` | String concat with `+` instead of templates |
| `@typescript-eslint/no-unused-vars` | Unused variables and destructured values |
| `react-hooks/exhaustive-deps` | Missing/incorrect hook dependency arrays |

## Procedure

1. Check if the project has an existing ESLint config.
2. Run each rule with `--format json` to get structured output:
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

## Why this matters

The agent naturally scans for "important" issues and skips stylistic ones. 
Inline styles and index keys look harmless at a glance but cause real performance problems.
Deterministic lint coverage catches what attention-based scanning misses.
