// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/*.tsbuildinfo",
      // Git submodule with its own repo.
      "packages/argent-private/",
      "packages/argent/bin/",
      "packages/argent/dylibs/",
      "packages/argent/assets/",
      "packages/argent/skills/",
      "packages/argent/agents/",
      "packages/argent/rules/",
      "packages/native-devtools-ios/bin/",
      "packages/native-devtools-ios/dylibs/",
      // Fetched by scripts/download-trace-processor.sh.
      "packages/native-devtools-android/assets/trace-processor/",
      "packages/docs/build/",
      "packages/docs/.docusaurus/",
      "packages/docs/static/",
      "coverage/",
    ],
  },

  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Explicit list rather than `projectService`, which would not pick up
        // the per-package tsconfig.test.json. The glob also matches
        // packages/docs, which is outside the npm workspaces, so `npm ci` there
        // has to run before this lint (see .github/workflows/lint.yml).
        project: ["packages/*/tsconfig.json", "packages/*/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // checksVoidReturn flags legitimate async callbacks (event handlers,
      // array iteration).
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Pre-existing debt, off to keep the gate green; ratchet each back to
      // "error".
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

  {
    files: ["packages/docs/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Mocks and partial fixtures trip these.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/tests/**"],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "no-empty": "off",
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
