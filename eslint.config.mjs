// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Not linted: build outputs, deps, generated/copied assets, and the
    // argent-private submodule (it has its own repo and CI). Mirrors the
    // ignores in .prettierignore + .gitignore.
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/*.tsbuildinfo",
      "packages/argent-private/",
      "packages/argent/bin/",
      "packages/argent/dylibs/",
      "packages/argent/assets/",
      "packages/argent/skills/",
      "packages/argent/agents/",
      "packages/argent/rules/",
      "packages/native-devtools-ios/bin/",
      "packages/native-devtools-ios/dylibs/",
      // Downloaded Perfetto trace-processor bundle (git-ignored build artifact,
      // fetched by download-trace-processor.sh) — generated, not ours to lint.
      "packages/native-devtools-android/assets/trace-processor/",
      "coverage/",
    ],
  },

  // Keep the gate honest: a stale or unjustified `eslint-disable` is a hard
  // error, so suppressions can't quietly pile up or be used to dodge a rule.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  // Type-aware linting for the TypeScript sources — this is where the value is
  // (floating promises, misused promises, throwing non-Errors, etc.).
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService`: each package keeps
        // its test files in a separate tsconfig.test.json (which projectService
        // does not auto-discover), so we point the type-aware parser at both.
        project: ["packages/*/tsconfig.json", "packages/*/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // --- Kept on, tuned ---
      // Catch the real promise hazards (a promise used in a condition or
      // spread) while skipping the noisy void-return variant that flags
      // legitimate async callbacks (event handlers, array iteration, etc.).
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      // Allow intentionally-unused identifiers when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // --- Parked: pre-existing debt, out of scope for the initial rollout ---
      // These flag broad classes of existing code (mostly `any` flowing across
      // untyped boundaries, and stylistic cleanups). Turned off now so the gate
      // is green; ratchet each back to "error" in follow-up passes.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Test files lean on mocks/stubs and partial fixtures; relax the rules that
  // fight that without losing the promise-correctness checks.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/tests/**"],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "no-empty": "off",
    },
  },

  // Plain JS — this config plus the loosely-typed build/dev scripts. No type
  // information available, so disable the type-checked rules for these.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
