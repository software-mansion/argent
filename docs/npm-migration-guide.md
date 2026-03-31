# Migrating from GitHub Packages to the public npm registry

This guide lists every change required to distribute `@software-mansion/argent`
through the public npm registry (`https://registry.npmjs.org`) instead of the
private GitHub Packages registry (`https://npm.pkg.github.com`).

---

## Why this simplifies things

GitHub Packages requires every consumer to:

1. Create a GitHub PAT with `read:packages` scope.
2. Configure `~/.npmrc` with a scoped registry and auth token.
3. Optionally authorise the PAT for SSO if the org enforces it.

With the public npm registry, **none of that is needed**. Users just run:

```bash
npm install -g @software-mansion/argent
```

No `.npmrc`, no tokens, no scoped registry configuration. Third-party
dependencies resolve from the same registry automatically.

---

## Checklist

### 1. `packages/mcp/package.json` — publishConfig

**Current:**

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

**Change to:**

```json
"publishConfig": {
  "access": "public"
}
```

- Remove `registry` entirely — npm defaults to `https://registry.npmjs.org`.
- Change `access` from `"restricted"` to `"public"`. Scoped packages on npmjs
  default to restricted; `"public"` is needed to make it downloadable by anyone.

> If you want the package to be private on npmjs (requires a paid npm org),
> keep `"access": "restricted"` and configure org-level access. Users would
> then need an npm token instead of a GitHub PAT.

---

### 2. `packages/mcp/src/cli/constants.ts` — NPM_REGISTRY

**Current:**

```typescript
export const NPM_REGISTRY = "https://npm.pkg.github.com";
```

**Change to:**

Remove the constant entirely and delete every import of it. The `npm view`
command in `utils.ts` works against the default registry when no `--registry`
flag is provided:

```typescript
// packages/mcp/src/cli/utils.ts — getLatestVersion()
export function getLatestVersion(): string {
  const result = execSync(`npm view ${PACKAGE_NAME} version`, {
    encoding: "utf8",
  });
  return result.trim();
}
```

If you prefer to keep the constant for explicitness:

```typescript
export const NPM_REGISTRY = "https://registry.npmjs.org";
```

Either approach works — the default npm registry is `registry.npmjs.org`.

---

### 3. `packages/mcp/src/cli/utils.ts` — getLatestVersion()

Remove the `--registry ${NPM_REGISTRY}` flag from the `npm view` call.
After migration, the user's default registry is correct for this package.

**Current:**

```typescript
import { PACKAGE_NAME, NPM_REGISTRY } from "./constants.js";
// ...
export function getLatestVersion(): string {
  const result = execSync(
    `npm view ${PACKAGE_NAME} version --registry ${NPM_REGISTRY}`,
    { encoding: "utf8" },
  );
  return result.trim();
}
```

**Change to:**

```typescript
import { PACKAGE_NAME } from "./constants.js";
// ...
export function getLatestVersion(): string {
  const result = execSync(
    `npm view ${PACKAGE_NAME} version`,
    { encoding: "utf8" },
  );
  return result.trim();
}
```

---

### 4. `.github/workflows/publish.yml`

**Current:**

```yaml
name: Publish to GitHub Packages

jobs:
  publish:
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://npm.pkg.github.com'
          scope: '@software-mansion'

      - run: npm publish --workspace packages/mcp
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Change to:**

```yaml
name: Publish to npm

jobs:
  publish:
    permissions:
      contents: read
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - run: npm publish --workspace packages/mcp
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Key differences:

| | GitHub Packages | Public npm |
|---|---|---|
| `registry-url` | `https://npm.pkg.github.com` | `https://registry.npmjs.org` |
| `scope` | `'@software-mansion'` | remove (not needed) |
| `permissions` | `packages: write` | remove (not an npm concept) |
| Token secret | `GITHUB_TOKEN` (built-in) | `NPM_TOKEN` (must be created) |

**Creating the npm token:**

1. Log in at [npmjs.com](https://www.npmjs.com).
2. Go to **Access Tokens** → **Generate New Token** → **Automation** type.
3. Copy the token.
4. In the GitHub repo, go to **Settings → Secrets → Actions** and create a
   secret named `NPM_TOKEN` with the token value.

---

### 5. `packages/mcp/test/cli/update.test.ts`

Remove or update the test that asserts `NPM_REGISTRY` points to
`npm.pkg.github.com`.

**Current:**

```typescript
import { PACKAGE_NAME, NPM_REGISTRY } from "../../src/cli/constants.js";

it("NPM_REGISTRY is the GitHub packages registry", () => {
  expect(NPM_REGISTRY).toContain("npm.pkg.github.com");
});
```

**If you removed `NPM_REGISTRY`:** delete this test and its import.

**If you kept it with the new value:**

```typescript
it("NPM_REGISTRY is the public npm registry", () => {
  expect(NPM_REGISTRY).toContain("registry.npmjs.org");
});
```

---

### 6. Documentation

These files reference GitHub Packages, auth tokens, or scoped registries.
Each needs updating to reflect the simpler public npm flow.

| File | What to change |
|------|----------------|
| `docs/cli-usage.md` | Remove the entire "Configure the scoped registry" section. Installation becomes just `npm install -g @software-mansion/argent`. Remove the `.npmrc` setup from the CI section. |
| `docs/distribution-guide.md` | Rewrite the "GitHub Packages — private registry" section. Replace with a brief note that the package is on npmjs.org. Remove PAT/auth instructions. Update the install command reference. |
| `INSTALL.md` | Remove Steps 1 and 2 (PAT creation and `.npmrc` setup). The install step becomes a single command. Remove the CI token section or replace with npm token instructions. |
| `README.md` | Replace the "GitHub Packages" mention with "npm". Remove the auth prerequisite from the install section. |
| `RELEASING.md` | Update references from "GitHub Packages" to "npm". Update the publish workflow description. Change the "Version already exists" troubleshooting to reference npmjs instead. |
| `scripts/test-install-matrix.sh` | No changes needed — it already installs from a local tarball, not from a registry. |

---

### 7. Org setup on npmjs.com (prerequisite)

Before the first publish, the `@software-mansion` scope must exist on npmjs:

1. Create an npm organization at
   [npmjs.com/org/create](https://www.npmjs.com/org/create) named
   `software-mansion` (must match the `@software-mansion` scope).
2. Or, if a user account owns the scope, publishing under it works too.
3. Ensure the automation token (step 4 above) belongs to a user who is a
   **member with publish access** in that org.

---

## What does NOT change

These parts of the codebase are registry-agnostic and require no modification:

- **`packages/mcp/src/cli/init.ts`** — no registry references.
- **`packages/mcp/src/cli/update.ts`** — already fixed to not pass
  `--registry` in install commands.
- **`packages/mcp/src/cli/uninstall.ts`** — no registry references.
- **`packages/mcp/src/cli/utils.ts` (other than `getLatestVersion`)** —
  `globalInstallCommand` and `globalUninstallCommand` have no registry flags.
- **`packages/mcp/src/cli/mcp-configs.ts`** — editor config adapters are
  registry-agnostic.
- **MCP server entry** — uses `argent-mcp` binary name, unrelated to registry.
- **Skills, rules, agents** — bundled assets, no registry dependency.
- **`bin/` directory** — native binary, no registry dependency.

---

## Migration order

1. Create the npm org / claim the scope on npmjs.com.
2. Create the `NPM_TOKEN` secret in the GitHub repo.
3. Apply all code changes (items 1–5 above) in a single PR.
4. Update all documentation (item 6) in the same PR.
5. Merge and tag a new version — `publish.yml` will push to npmjs.org.
6. Verify: `npm view @software-mansion/argent` should return the new version
   without any `--registry` flag or `.npmrc` configuration.
7. Announce to users that `.npmrc` scoped registry configuration is no longer
   needed and can be removed.
