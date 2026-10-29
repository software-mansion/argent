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

- **macOS** with Xcode installed for iOS simulator work (`xcrun simctl`). On Linux `npm run dev` skips the iOS dylibs.
- **Node.js 20.19+** (the lint toolchain's floor; the published package needs 20.12+)
- The [GitHub CLI](https://cli.github.com/) (`gh`), logged in with `gh auth login`, to download the prebuilt native binaries

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

3. **Download the prebuilt native binaries** (simulator-server, ax-service, the native devtools dylibs and the Perfetto trace-processor, all gitignored):

   ```bash
   npm run download:simulator-server
   npm run download:native-binaries
   npm run download:trace-processor
   ```

4. **Build the workspace packages** once, so the dev script can resolve them:

   ```bash
   npm run build
   ```

5. **Start the dev environment:**

   ```bash
   npm run dev
   ```

   On macOS this builds the native devtools dylibs from the private `packages/argent-private` submodule if you have SSH access to it, and otherwise uses the ones from step 3. It then builds the dispatcher, points `~/.claude.json`, `~/.cursor/mcp.json` and `~/.argent/cli.json` at the local build, and starts the tool-server from source. Press `Ctrl+C` to stop and restore your global Argent configuration.

   To use a different port:

   ```bash
   PORT=4000 npm run dev
   ```

That's it, no separate install steps per package are needed, except `packages/docs`. It is excluded from the workspace glob and keeps its own lockfile, so `npm run lint` from the root needs `npm install` run inside `packages/docs` first.

---

## Project structure

This is an npm workspaces monorepo. All packages live under `packages/`:

| Package                           | Path                               | Purpose                                                                                                                                         |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@argent/registry`                | `packages/registry`                | Core library: dependency-aware service lifecycle, blueprints, tools, URNs                                                                       |
| `@argent/tool-server`             | `packages/tool-server`             | HTTP API over the registry (port 3001). Registers all blueprints and tools                                                                      |
| `@swmansion/argent`               | `packages/argent`                  | Published bin shell: minimal dispatcher + bundled subcommands + native runtime assets                                                           |
| `@argent/tools-client`            | `packages/argent-tools-client`     | HTTP client + tool-server launcher shared by `@argent/mcp` and `@argent/cli`                                                                    |
| `@argent/mcp`                     | `packages/argent-mcp`              | MCP stdio protocol adapter that proxies Claude/Cursor calls to the tool-server                                                                  |
| `@argent/cli`                     | `packages/argent-cli`              | Shell CLI commands, e.g. `argent run`, `argent tools`, `argent server`, `argent e2e`, `argent flags`, `argent config`                           |
| `@argent/installer`               | `packages/argent-installer`        | Workspace setup logic: `argent init`, `update`, `uninstall`                                                                                     |
| `@argent/skills`                  | `packages/skills`                  | Markdown skill files (prefixed `argent-*`) that instruct AI agents how to use Argent tools                                                      |
| `@argent/native-devtools-ios`     | `packages/native-devtools-ios`     | Native binary resolver and dylib build script for iOS simulator injection. ObjC source lives in `packages/argent-private` _(private submodule)_ |
| `@argent/native-devtools-android` | `packages/native-devtools-android` | Android helper APK resolver, Perfetto trace-processor wrapper and profiling queries                                                             |
| `@argent/device-providers`        | `packages/device-providers`        | Contract for external device providers (schema v1): types, validators, discovery and publish helpers                                            |
| `@argent/ios-device-runner`       | `packages/ios-device-runner`       | XCUITest runner that drives physical iOS devices                                                                                                |
| `@argent/configuration-core`      | `packages/configuration-core`      | Feature flag registry, JSON storage and `isFlagEnabled`                                                                                         |
| `@argent/update-core`             | `packages/update-core`             | npm release-age detection and install target resolution for `argent update`                                                                     |
| `@argent/telemetry`               | `packages/telemetry`               | Opt-out telemetry client for the CLI, installer and tool-server                                                                                 |
| `@argent/archive`                 | `packages/archive`                 | Shared tar.gz helpers for creating and extracting archives                                                                                      |
| `@argent/preview-window`          | `packages/preview-window`          | Electron host for the Argent Lens variant preview and selection UI                                                                              |
| `@argent/ui`                      | `packages/ui`                      | Browser UI that streams a simulator and forwards taps and gestures to simulator-server                                                          |
| `argent`                          | `packages/argent-alias`            | Alias package so `npx argent <command>` runs `@swmansion/argent` (outside the workspace)                                                        |
| `argent-docs`                     | `packages/docs`                    | Docusaurus docs site for docs.swmansion.com/argent (outside the workspace, own lockfile)                                                        |

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
npm run build -w @swmansion/argent
# or, to also produce a .tgz tarball:
npm run pack:mcp
```

---

## Running the project

For day-to-day development, use `npm run dev` (see [Setting up the dev environment](#setting-up-the-dev-environment)).

**Tool-server only** (no MCP or editor config patching):

```bash
npm run start
```

This builds the registry, then starts the tool-server from source via `ts-node` on port 3001.

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
- **Target:** ES2022. Packages with `"type": "module"` in their `package.json` (e.g. `@swmansion/argent`, `@argent/cli`, `@argent/mcp`) are ESM; the rest are CommonJS.
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
5. **Check for dead code**, in a tree with no compiled output:
   ```bash
   npx tsc --build --clean
   npm run knip
   ```
   `--clean` removes what `tsc` emitted; the few non-TypeScript assets `npm run build` copies into `packages/tool-server/dist` are left behind. Knip does not look at them, so the report is the same either way.
   Run it this way round, not straight after step 3. The gate is counted against an unbuilt tree, because that is what CI analyses; with `packages/*/dist` present knip finds fewer issues, so a built-tree run carries phantom headroom and can pass locally while the Dead Code job fails. This leaves the tree unbuilt, so run `npm run build` again before re-running any test suite. The gate runs at `--max-issues 0`, so the report must come back empty and there is no ceiling to raise: when knip names an export or type you added, drop the `export` keyword if the symbol is still used inside its own file, or delete it if nothing uses it. When the only caller is somewhere knip cannot see — another workspace, because the unbuilt tree breaks cross-workspace edges, or the `argent-private` submodule, which CI does not check out — tag the declaration `/** @public */` and name that caller in the comment. Look for that caller before you delete. This gate stays green on a wrong delete either way, but the two cases differ after that: deleting a symbol another workspace calls turns `npm run build` and that workspace's tests red, so that mistake is caught, while deleting one only `argent-private` reaches breaks nothing here — it `require()`s the built `dist/*.js`, and CI never checks that submodule out.
6. **Write a clear PR title** — it becomes part of the release changelog. Use the same prefix convention as commit messages (`feat:`, `fix:`, etc.).
7. **Open the PR** against `main` and fill in the description with context on what changed and why.
8. A maintainer will review and may request changes. Address feedback with new commits (don't force-push after review starts).

---

## Questions?

If you're unsure about something, open a GitHub Discussion or leave a comment on the relevant issue before spending time on a large change.
