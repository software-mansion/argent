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
- The `simulator-server` binary at the repo root (arm64 macOS, included in the repo)

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

That's it — no separate install steps per package are needed.

---

## Project structure

This is an npm workspaces monorepo. All packages live under `packages/`:

| Package | Path | Purpose |
|---|---|---|
| `@argent/registry` | `packages/registry` | Core library: dependency-aware service lifecycle, blueprints, tools, URNs |
| `@argent/tool-server` | `packages/tool-server` | HTTP API over the registry (port 3001). Registers all blueprints and tools |
| `@argent/mcp` | `packages/mcp` | MCP bridge — exposes tools to AI assistants via Model Context Protocol |
| `@argent/ui` | `packages/ui` | Web UI for simulator control and Metro debugging (Vite + React) |
| `@argent/skills` | `packages/skills` | Markdown skill files that instruct AI agents how to use Argent tools |

The `tsconfig.json` at the root uses TypeScript project references; `tsconfig.base.json` holds shared compiler options (`strict`, `ES2022`, etc.).

---

## Building

Build all packages at once using TypeScript project references:

```bash
npm run build
```

To build a specific package:

```bash
npm run build -w @argent/registry
npm run build -w @argent/tool-server
npm run build -w @argent/ui
```

To build and bundle the distributable MCP package:

```bash
npm run build -w @software-mansion/argent
# or, to also produce a .tgz tarball:
npm run pack:mcp
```

---

## Running the project

**Full stack (tools server + UI):**

```bash
npm run start
```

This builds the registry, then concurrently starts the tools server on port 3001 and the Vite UI dev server on port 5173.

**Tools server only (no UI):**

```bash
npm run start:tool-server
```

**UI only:**

```bash
npm run start:ui
```

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
npm test -w @argent/ui
```

Run tests in watch mode during development:

```bash
npm run test:watch -w @argent/registry
npm run test:watch -w @argent/tool-server
```

There are also integration/e2e tests in `packages/tool-server/test/` (e.g. `metro-cdp-verify.ts`, `test-breakpoint-e2e.ts`). These require a running simulator and are not part of the standard `vitest run` suite — see the files for individual instructions.

---

## Code style

- **TypeScript strict mode** is enabled across all packages (`"strict": true` in `tsconfig.base.json`). All code must compile without errors.
- **Target:** ES2022 with CommonJS modules (except `@argent/ui` and `@software-mansion/argent` which use ESM).
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

### Release process

Maintainers handle releases by bumping the version in `packages/mcp/package.json` and pushing a `v*` tag. See [RELEASING.md](./RELEASING.md) for the full process.

---

## Questions?

If you're unsure about something, open a GitHub Discussion or leave a comment on the relevant issue before spending time on a large change.
