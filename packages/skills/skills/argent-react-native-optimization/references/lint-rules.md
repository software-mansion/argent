# Phase 1: Lint Rules

Run once at the project root. Catches mechanical issues deterministically.
Install missing plugins before running. On ESLint 10, `eslint-plugin-react-native` crashes: install with `--legacy-peer-deps` (npm; pnpm only warns) and run `npx eslint@9`.
With React Compiler active, leave out the react-perf rules, `react/jsx-no-bind` and `react-native/no-inline-styles`, unless the compiler skips some components (`compilationMode: "annotation"`, `"use no memo"`, a `sources` filter).

## Rules

### Performance (eslint-plugin-react-perf)

| Rule                                     | Catches                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `react-perf/jsx-no-new-object-as-prop`   | Object literals `{}` as JSX props - new ref every render |
| `react-perf/jsx-no-new-array-as-prop`    | Array literals `[]` as JSX props - new ref every render  |
| `react-perf/jsx-no-new-function-as-prop` | Arrow functions / function expressions as JSX props      |
| `react-perf/jsx-no-jsx-as-prop`          | JSX elements as prop values (e.g. `icon={<Icon />}`)     |

### React (eslint-plugin-react)

| Rule                                      | Catches                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `react/no-array-index-key`                | `key={index}` - incorrect reconciliation on reorder                 |
| `react/jsx-no-bind`                       | `.bind()` in JSX props - new function ref every render              |
| `react/jsx-no-constructed-context-values` | Object/array literals as Context `value` - re-renders all consumers |
| `react/no-unstable-nested-components`     | Components defined inside render - full remount each render         |
| `react/no-object-type-as-default-prop`    | Object/array defaults in destructuring (e.g. `{ items = [] }`)      |

### React Native (eslint-plugin-react-native)

| Rule                                          | Catches                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `react-native/no-inline-styles`               | Inline `style={{}}` - defeats shallow comparison |
| `react-native/no-unused-styles`               | StyleSheet rules never referenced                |
| `react-native/no-color-literals`              | Color literals in styles instead of constants    |
| `react-native/no-single-element-style-arrays` | `style={[single]}` instead of `style={single}`   |

### Hooks (eslint-plugin-react-hooks)

| Rule                          | Catches                                  |
| ----------------------------- | ---------------------------------------- |
| `react-hooks/exhaustive-deps` | Missing/incorrect hook dependency arrays |
| `react-hooks/rules-of-hooks`  | Hooks called conditionally or in loops   |

### Error handling (ESLint core)

| Rule                                       | Catches                               |
| ------------------------------------------ | ------------------------------------- |
| `no-empty` (with `allowEmptyCatch: false`) | Empty catch blocks - swallowed errors |

## Procedure

1. Add the rules above for this run only: extend the project's ESLint config, or on ESLint 10 use a temporary flat config that spreads it. With no project config, create a temporary `eslint.config.mjs`; on a TypeScript project give it `typescript-eslint`'s parser, or every `.tsx` file fails to parse.
2. Run: `npx eslint --format json <src_dir>` (`npx eslint@9 -c <temp config>` on ESLint 10); replace `<src_dir>` with the project's JS/TS source root (check `package.json` scripts or look for `src/`, `app/`, `lib/`)
3. Parse output into: `file:line -> rule -> message`.
