# Phase 1: Lint Rules

Run once at the project root before reading any code. Catches mechanical issues deterministically.

## Rules

| Rule | Catches |
| ---- | ------- |
| `react-native/no-inline-styles` | Inline `style={{}}` — new object every render, defeats shallow comparison |
| `react/no-array-index-key` | `key={index}` — incorrect reconciliation on reorder/insert/delete |
| `react-hooks/exhaustive-deps` | Missing/incorrect hook dependency arrays |

## Procedure

1. Check if the project has an existing ESLint config with these rules.
2a. If yes, run: `npx eslint --format json {src_dir}`
2b. If no config exists, run with explicit plugins and parser:
   ```bash
   npx eslint --no-eslintrc \
     --parser @typescript-eslint/parser \
     --plugin react --plugin react-native --plugin react-hooks \
     --rule 'react-native/no-inline-styles: error' \
     --rule 'react/no-array-index-key: error' \
     --rule 'react-hooks/exhaustive-deps: error' \
     --format json {src_dir}
   ```
3. Parse output into: `file:line -> rule -> message`.
4. Dispatch sub-agents to fix results — one sub-agent per file with hits.
5. Collect `exhaustive-deps` hits for Phase 3 — they need semantic reasoning.
