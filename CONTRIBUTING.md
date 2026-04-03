# Contributing to Argent

Thank you for your interest in contributing to Argent! This guide covers everything you need to get started.

## Table of contents

- [Requirements](#requirements)
- [Setting up the dev environment](#setting-up-the-dev-environment)
- [Project structure](#project-structure)
- [Building](#building)
- [Running the project](#running-the-project)
- [Running tests](#running-tests)
- [Code style](#code-style)
- [Submitting a pull request](#submitting-a-pull-request)

---

## Requirements

- **macOS** with Xcode installed (required for `xcrun simctl` and iOS simulator support)
- **Node.js 18+**
- The `simulator-server` binary (arm64 macOS, installed separately via `npx @software-mansion/argent install`)

---

## Setting up the dev environment

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/software-mansion/argent.git
   cd argent
   ```

2. **Install dependencies** (npm workspaces installs all packages at once):

   ```bash
   npm install
   ```

3. **Start the dev environment:**

   ```bash
   npm run dev
   ```

   This builds the native devtools dylibs (if the private submodule is available, otherwise uses pre-built binaries), compiles the MCP TypeScript, patches `~/.claude.json` to point at the local MCP, and starts the tool-server from source via `ts-node`. Press `Ctrl+C` to stop — the script automatically restores your global Argent configuration.

   To use a different port:

   ```bash
   PORT=4000 npm run dev
   ```

   > **Note:** `packages/argent-private` is a private git submodule that holds the ObjC source for the native devtools dylibs. If you don't have SSH access to it, `npm run dev` will use the pre-built dylibs committed to the repository — everything else works normally.

That's it — no separate install steps per package are needed.

---

## Project structure

This is an npm workspaces monorepo. All packages live under `packages/`:

| Package | Path | Purpose |
|---|---|---|
| `@argent/registry` | `packages/registry` | Core library: dependency-aware service lifecycle, blueprints, tools, URNs |
| `@argent/tool-server` | `packages/tool-server` | HTTP API over the registry (port 3001). Registers all blueprints and tools |
| `@software-mansion/argent` | `packages/mcp` | MCP bridge — exposes tools to AI assistants via Model Context Protocol |
| `@argent/skills` | `packages/skills` | Markdown skill files (prefixed `argent-*`) that instruct AI agents how to use Argent tools |
| `@argent/native-devtools-ios` | `packages/native-devtools-ios` | Pre-built dylibs for iOS simulator injection (view hierarchy, network inspection). ObjC source lives in `packages/argent-private` _(private submodule)_ |

The `tsconfig.json` at the root uses TypeScript project references; `tsconfig.base.json` holds shared compiler options (`strict`, `ES2022`, etc.).

---

## Building

### Local development (recommended)

```bash
npm run dev
```

Builds everything and starts the tool-server from source. See [Setting up the dev environment](#setting-up-the-dev-environment) for details.

### Full build

Build all packages at once using TypeScript project references:

```bash
npm run build
```

To build a specific package:

```bash
npm run build -w @argent/registry
npm run build -w @argent/tool-server
```

To build and bundle the distributable MCP package:

```bash
npm run build -w @software-mansion/argent
# or, to also produce a .tgz tarball:
npm run pack:mcp
```

---

## Running the project

For day-to-day development, use `npm run dev` (see [Setting up the dev environment](#setting-up-the-dev-environment)).

**Production-like start** (builds bundles first, then starts from compiled output):

```bash
npm run start
```

This builds the registry, then starts the tools server on port 3001.

Verify the tools server is up:

```bash
curl http://localhost:3001/tools
```

---

## Running tests

Tests are written with [Vitest](https://vitest.dev/). Each package has its own test suite.

Run tests for a specific package:

```bash
npm test -w @argent/registry
npm test -w @argent/tool-server
```

Run tests in watch mode during development:

```bash
npm run test:watch -w @argent/registry
npm run test:watch -w @argent/tool-server
```

---

## Code style

- **TypeScript strict mode** is enabled across all packages (`"strict": true` in `tsconfig.base.json`). All code must compile without errors.
- **Target:** ES2022 with CommonJS modules (except `@software-mansion/argent` which uses ESM).
- Prefer explicit types over `any`. Use Zod schemas for runtime validation where the codebase already does so.
- Keep commits focused. Prefix commit messages with a type: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. This feeds the auto-generated changelog on release.

---

## Submitting a pull request

1. **Create a branch** from `main` with a descriptive name (e.g. `feat/add-screenshot-tool`, `fix/session-leak`).
2. **Make your changes.** Keep the scope of a PR small and focused — it's easier to review.
3. **Ensure the build passes:**
   ```bash
   npm run build
   ```
4. **Ensure tests pass** for the packages you touched.
5. **Write a clear PR title** — it becomes part of the release changelog. Use the same prefix convention as commit messages (`feat:`, `fix:`, etc.).
6. **Open the PR** against `main` and fill in the description with context on what changed and why.
7. A maintainer will review and may request changes. Address feedback with new commits (don't force-push after review starts).

---

## Questions?

If you're unsure about something, open a GitHub Discussion or leave a comment on the relevant issue before spending time on a large change.
