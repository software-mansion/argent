// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// packages/docs is excluded from the root npm workspaces and keeps its own
// lockfile, so it also keeps its own ESLint setup. The root config ignores this
// directory. Prettier config is shared: it resolves the .prettierrc at the repo
// root.
export default tseslint.config(
  {
    // Build outputs, deps and static assets are generated or vendored.
    ignores: ["build/", ".docusaurus/", "node_modules/", "static/"],
  },

  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  // Swizzled theme components and pages. Type-aware linting is off here: the
  // Docusaurus module aliases live in the generated .docusaurus directory, so a
  // typed lint would need a site build first. `npm run typecheck` covers types.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Site configuration — plain CommonJS/ESM JavaScript that runs in Node.
  {
    files: ["*.js", "*.mjs", "*.cjs"],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
