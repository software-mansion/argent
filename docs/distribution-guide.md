# Argent Distribution Guide

This document is the canonical reference for how `@software-mansion/argent` is
distributed, how the CI/CD pipeline works, and how end users authenticate to install
the package from the private GitHub Packages registry.

---

## Table of contents

1. [Overview](#overview)
2. [The npx CLI](#the-npx-cli)
3. [CI/CD pipeline](#cicd-pipeline)
4. [GitHub Packages — private registry](#github-packages--private-registry)
5. [Granting users access](#granting-users-access)
6. [What gets shipped in the tarball](#what-gets-shipped-in-the-tarball)

---

## Overview

Argent is published as a **private npm package** (`@software-mansion/argent`) to
[GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

Distribution is fully automated:

```
Developer pushes v* tag
        │
        ▼
  release.yml — creates a GitHub Release with auto-generated changelog
        │
        ▼
  publish.yml — npm ci → build → npm publish → package appears in GitHub Packages
        │
        ▼
End user: npx @software-mansion/argent install
```

The package exposes a CLI (`argent`) that handles install, update, and removal entirely —
users never have to touch MCP config files by hand.

---

## The npx CLI

### Entry points

`packages/mcp/package.json` declares three binaries:

| Binary | Entry point | Purpose |
|---|---|---|
| `argent` | `dist/cli.js` | User-facing CLI (`install`, `update`, `remove`) |
| `argent-mcp` | `dist/index.js` | MCP stdio server (started by AI clients) |
| `argent-simulator-server` | `bin/simulator-server` | Alias to the native simulator binary |

### Commands

```bash
npx @software-mansion/argent install   [path]
npx @software-mansion/argent update    [path]
npx @software-mansion/argent remove    [path] [--prune]
```

`path` is optional — defaults to the current working directory. `--prune` tells `remove`
to also delete the copied `.claude/skills`, `.claude/agents`, `.claude/rules`, and
`.cursor/rules` directories.

### What `install` does

1. Runs `npm install @software-mansion/argent` in the target project directory
   (with `ARGENT_SKIP_POSTINSTALL=1` to avoid running the package's own `postinstall`
   script a second time). The user's `~/.npmrc` must have the scoped registry
   configured so `@software-mansion/*` resolves to GitHub Packages while other
   dependencies resolve from npmjs.org normally.
2. Writes (or merges) the MCP server entry into:
   - `.claude/mcp.json`
   - `.cursor/mcp.json`
   - `.mcp.json`
3. Adds the `mcp__argent` permission entry to `.claude/settings.json`.
4. Copies `skills/`, `agents/`, and `rules/` from the installed package into:
   - `.claude/skills/`
   - `.claude/agents/`
   - `.claude/rules/`
   - `.cursor/rules/`

### What `update` does

1. Reads the version currently installed in the target project's `node_modules`.
2. Queries the latest published version via `npm view @software-mansion/argent version`
   (uses the npm CLI — respects `~/.npmrc` auth automatically).
3. If a newer version exists, runs `npm install @software-mansion/argent@<latest>`.
4. Re-runs the full configure step (MCP entries, permissions, file copies) regardless of
   whether a version upgrade happened, ensuring workspace files are always fresh.

### What `remove` does

1. Removes the `argent` entry from all three MCP config files.
2. Removes the `mcp__argent` permission from `.claude/settings.json`.
3. Runs `npm uninstall @software-mansion/argent`.
4. With `--prune`: deletes `.claude/skills`, `.claude/agents`, `.claude/rules`, and
   `.cursor/rules`.

### How the MCP server is started at runtime

When an AI client (Claude, Cursor) starts the MCP server, it runs `node dist/index.js`
(the `argent-mcp` binary). That process:

1. Calls `ensureToolsServer()` in `launcher.ts`.
2. Checks `~/.argent/tool-server.json` for a running tools-server PID + port.
3. If the process is alive and healthy (`GET /tools` returns 200), reuses it.
4. Otherwise spawns a new Node process running `dist/tool-server.cjs` (a self-contained
   esbuild bundle), waits for the "listening" log line, and persists the new state.
5. Returns the `http://127.0.0.1:<port>` URL used to proxy all tool calls.

This means the tools server is a **persistent background process** shared across all MCP
client sessions — it is not restarted on every tool call.

---

## CI/CD pipeline

### Workflow files

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/release.yml` | `push` to any `v*` tag | Creates a GitHub Release with an auto-generated changelog from merged PR titles |
| `.github/workflows/publish.yml` | `release` event (`created`) | Installs deps, builds the MCP package, publishes to GitHub Packages |

### `release.yml` — create a release

```yaml
on:
  push:
    tags:
      - 'v*'
```

Uses `actions/github-script` to call the GitHub Releases API. The changelog is generated
automatically from merged pull request titles since the previous tag — no manual changelog
maintenance is needed.

Permissions required: `contents: write`.

### `publish.yml` — build and publish

```yaml
on:
  release:
    types: [created]
```

Steps, in order:

1. `actions/checkout@v4` — checks out the repository at the tagged commit.
2. `actions/setup-node@v4` — installs Node 20 and **configures npm to point at GitHub
   Packages** for the `@software-mansion` scope via `registry-url` + `scope`.
3. `npm ci` — installs all workspace dependencies (required to build TypeScript).
4. `npm run build -w @software-mansion/argent` — compiles TypeScript and runs
   `scripts/bundle-tools.cjs` to produce the esbuild bundle. This step generates the
   `dist/` directory that is included in the published tarball.
5. `npm publish --workspace packages/mcp` — publishes the package to GitHub Packages.

The `NODE_AUTH_TOKEN` environment variable is set to the built-in `GITHUB_TOKEN` secret.
`actions/setup-node` writes a temporary `.npmrc` that wires that token to the registry URL,
so no manually created token is needed in the workflow itself.

Permissions required: `contents: read`, `packages: write`.

### Triggering a release

```bash
# 1. Bump version
npm version patch --workspace packages/mcp --no-git-tag-version
git add packages/mcp/package.json
git commit -m "chore: bump argent to vX.Y.Z"
git push

# 2. Tag and push — this kicks off both workflows
git tag vX.Y.Z
git push origin vX.Y.Z
```

See [`RELEASING.md`](../RELEASING.md) for the full release runbook including failure recovery.

---

## GitHub Packages — private registry

### Why GitHub Packages

The source repository (`software-mansion/argent`) is private. GitHub Packages
enforces the same access control as the repository: only users and tokens with **read
access to the repository** can download the package.

`packages/mcp/package.json` contains:

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

`access: restricted` means the package is private (not publicly downloadable), consistent
with the private repo.

### How users authenticate

Users must have a GitHub Personal Access Token (PAT) with the `read:packages` scope,
added to their global `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=<GITHUB_PAT>
```

The `npm login` alternative:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@software-mansion
# Username: GitHub username
# Password: PAT (not GitHub account password)
# Email:    GitHub email
```

After authenticating and configuring the scoped registry, users can install
without any `--registry` flag — npm knows to fetch `@software-mansion/*` from
GitHub Packages while resolving third-party dependencies from npmjs.org:

```bash
npm install -g @software-mansion/argent
```

> **Important:** Do **not** pass `--registry https://npm.pkg.github.com` on the
> command line. That flag overrides the default registry for *all* packages in
> the dependency tree, causing 404s for third-party deps like `picocolors` that
> only exist on npmjs.org. The scoped registry in `.npmrc` is the correct
> approach.

Full step-by-step user instructions (including SSO, CI usage, and troubleshooting) are
in [`INSTALL.md`](../INSTALL.md).

### Using a token in CI

In a CI environment, set the token as an environment variable and reference it from
`.npmrc` (do not hard-code it):

```
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then expose `GITHUB_TOKEN` (or a PAT stored as a secret) in the CI job environment.

---

## Granting users access

To allow a new user to install the package:

1. **Add them as a collaborator** on `software-mansion/argent` (or add their
   GitHub account to the organisation with at least `read` access to the repository).
2. Ask them to follow the steps in [`INSTALL.md`](../INSTALL.md) to create a PAT and
   configure `~/.npmrc`.
3. If the organisation enforces SSO, they must also authorise their PAT for the
   `software-mansion` organisation (GitHub → PAT settings → Configure SSO).

There is no separate package-level access list — repository access **is** package access.

---

## What gets shipped in the tarball

The `files` field in `packages/mcp/package.json` controls what is included when
`npm publish` runs:

```json
"files": [
  "dist/",
  "bin/",
  "skills/",
  "agents/",
  "rules/",
  "scripts/"
]
```

| Path | Contents |
|---|---|
| `dist/` | Compiled JS: `index.js` (MCP server), `cli.js` (CLI), `tool-server.cjs` (esbuild bundle) |
| `bin/` | `simulator-server` native binary (arm64 macOS) |
| `skills/` | Markdown skill files for Claude / Cursor |
| `agents/` | Markdown agent files |
| `rules/` | Cursor rule files |
| `scripts/` | `postinstall.cjs` and other helper scripts |

`dist/` is **not** committed to git (it is `.gitignore`d). It is generated during the
`npm run build` step in `publish.yml` immediately before `npm publish`. If the build step
were skipped the published package would contain only the `bin/`, `skills/`, `agents/`,
`rules/`, and `scripts/` directories — the package would be non-functional. The build
step is therefore critical.

`skills/`, `agents/`, and `rules/` directories under `packages/mcp/` are also
`.gitignore`d locally (they are generated/copied from `packages/skills/`). They exist on
disk after a local dev install and are picked up by `npm pack` / `npm publish` correctly
because npm respects `files` over `.gitignore` at publish time.
