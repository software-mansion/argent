# PR Summary — Changes for Review

This document summarizes the changes in this PR for anyone acknowledging or reviewing it.

---

## 1. Package rename: `tools` → `tool-server`

- `packages/tools` has been renamed to `packages/tool-server`.
- Package name: `@argent/tools` → `@argent/tool-server`.
- All references across the repo (README, launch configs, skills, MCP README) have been updated to use `tool-server` and `packages/tool-server`.

---

## 2. Redundant files and tool-server structure

### Files made redundant (deleted)

- `packages/tools/src/activation-tui.ts` — Removed, as it was unused. Can be brought back if needed.
- `packages/tools/src/simulator-registry.ts` — Removed. Contained the old ad-hoc process and WebSocket registry for simulator-server instances. Replaced by the registry package’s blueprint-based lifecycle: the **SimulatorServer** blueprint and `@argent/registry` now manage per-UDID simulator-server processes and their resolution for tools.
- `**packages/tools/src/setup-registry.ts`** — Removed from package root. Its logic was moved to `**packages/tool-server/src/utils/setup-registry.ts**` (see structure changes below).
- `**packages/tools/tsconfig.tsbuildinfo**` — Build artifact; removed with the package.

### tool-server structure after rename

- `**src/utils/**` — New folder for shared setup and helpers:
  - `**utils/setup-registry.ts**` — Creates the registry, registers blueprints and tools (moved from `src/setup-registry.ts`).
  - `**utils/license.ts**` — License keychain read/write and activation helpers (moved from `src/license.ts`).
  - `**utils/simulator-client.ts**` — Simulator HTTP/WebSocket client (moved and renamed from `src/simulator-api.ts`).
  - `**utils/debugger/**` — New subtree for Metro/CDP debugger support: `cdp-client.ts`, `discovery.ts`, `source-maps.ts`, `source-resolver.ts`, `target-selection.ts`, and `scripts/` (e.g. `component-tree.ts`, `inspect-at-point.ts`, `render-hook.ts`).
- `**src/tools/**` — Reorganized from a flat list into subfolders:
  - `**tools/interactions/**` — `button`, `describe`, `gesture`, `keyboard`, `paste`, `screenshot`, `swipe`, `tap` (moved from `src/tools/*.ts`).
  - `**tools/license/**` — `activate-license-key`, `activate-sso`, `get-license-status`, `remove-license`.
  - `**tools/simulator/**` — `boot-simulator`, `launch-app`, `list-devices`, `open-url`, `rotate`, `simulator-server`.
  - `**tools/debugger/**` — New: `debugger-connect`, `debugger-status`, `debugger-evaluate`, `debugger-set-breakpoint`, `debugger-remove-breakpoint`, `debugger-pause`, `debugger-resume`, `debugger-step`, `debugger-component-tree`, `debugger-inspect-element`, `debugger-console-logs`, `debugger-console-listen`.
- **Blueprints** — Still under `src/blueprints/` (`simulator-server.ts`, `js-runtime-debugger.ts`); no path change.
- **Tests** — New/relocated under `test/`: Metro-related tests in `test/metro/`, plus `test-breakpoint-e2e.ts`, `test-breakpoint-hit.ts`, `metro-cdp-verify.ts`; **vitest.config.ts** added.

---

## 3. Root `package.json` scripts and tooling

- `build` — Now runs `tsc --build` (TypeScript project references) instead of building registry, tools, and mcp in sequence.
- **New scripts:**
  - `start` — Builds registry, then runs UI and tool-server concurrently (`concurrently`).
  - `start:ui` — Runs only the UI dev server.
  - `start:tool-server` — Builds registry and runs the tool-server in dev mode.
- **New devDependency:** `concurrently` for running UI and tool-server together.

---

## 4. README and documentation

- **README.md** was reworked for clarity:
  - Describes two surfaces: **simulator-server** (native binary at repo root) and **tools server** (Node app on port 3001).
  - **simulator-server** binary location is now stated as **repo root** (arm64 macOS), not `packages/server`.
  - Quick start and “Running the app with frontend” use `packages/tool-server` and the new root scripts where relevant.
  - Simulator-server API section clarified (options, token, curl examples); note added that an OpenAPI spec is not yet in the repo.
  - All “packages/tools” references replaced with “packages/tool-server”.
- **Docs changes:**
  - **Removed:** `docs/dictionary.md`, `docs/naming-suggestions.md`.
  - **Added:** `docs/reference.md` — dictionary/reference for packages, registry, tool server, simulator server, blueprints, tools, license, Metro/debugger, MCP, skills, and UI (replaces/extends the old dictionary).
  - **Added:** `docs/metro-debugger-features.md` — guide for the Metro/CDP debugger feature set: what was added, how to use it, and how to integrate with MCP and skills.

---

## 5. VS Code configuration

- `.vscode/launch.json`:
  - “Launch Program” replaced with named configs:
    - **Tools Server** — Runs `packages/tool-server` with ts-node (port 3001).
    - **Tools Server (built)** — Runs built `dist/index.js` with preLaunchTask `build-tools`.
    - **UI (Chrome)** — Launches Chrome against Vite dev server (port 5173), with preLaunchTask `start-vite`.
  - **Compound:** “Full (Tools + UI)” launches both Tools Server and UI (Chrome).
- `.vscode/tasks.json` (new):
  - `**start-vite`** — Runs `npm run dev -w @argent/ui` as a background task (problem matcher for Vite “Local:” URL).
  - `**build-tools**` — Runs root `npm run build` (used by “Tools Server (built)”).

---

## 6. Skills and MCP

- `**.claude/skills/simulator-screenshot.md**` — “Tools server not running” instruction updated from `packages/tools` to `packages/tool-server`.
- `**packages/mcp**` — README (or equivalent) text updated: “packages/tools” → “packages/tool-server” in the tool list description.

---

## 7. Dependencies (package-lock.json)

- Workspace mapping: `@argent/tools` → `@argent/tool-server` (and `packages/tools` → `packages/tool-server`).
- **@clack/prompts** (and **@clack/core**) bumped from 0.4.1/0.9.1 to **1.1.0** (used by tool-server).
- **concurrently** and its dependency tree added at the root (chalk, rxjs, shell-quote, tree-kill, yargs, etc.).
- **packages/tools** is now listed as **extraneous** in the lockfile (package directory renamed to tool-server; old name may still exist on disk).
- **source-map-js** — Dependency of tool-server; lockfile/usage adjusted as needed (e.g. no longer dev-only where used for runtime).

