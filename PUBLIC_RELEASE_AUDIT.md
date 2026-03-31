# Public Release Audit — radon-lite

> Full audit of issues to resolve before making the repository public.
> Generated: 2026-03-25

---

## Table of Contents

1. [Critical — Blocks Public Release](#1-critical--blocks-public-release)
2. [High — Looks Unprofessional](#2-high--looks-unprofessional)
3. [Medium — Should Clean Up](#3-medium--should-clean-up)
4. [Low — Nice to Fix](#4-low--nice-to-fix)

---

## 1. Critical — Blocks Public Release

### 1.1 No LICENSE file

There is no `LICENSE` file anywhere in the repository. No `license` field in any `package.json`. This is a hard blocker — without a license, the code is "all rights reserved" by default and nobody can legally use it.

**Files:** root, all `package.json` files

### 1.2 README and INSTALL say "the source repository is private"

The README and INSTALL docs explicitly tell users the repo is private and walk them through PAT-based auth for a private GitHub Packages registry. This directly contradicts a public release.

- `README.md:65` — "Because the source repository is private"
- `INSTALL.md:5` — "Because the source repository is private"
- `INSTALL.md:12` — "read access to `software-mansion/argent`"
- `INSTALL.md:25` — SSO instructions for `software-mansion` org

### 1.3 `publishConfig` is private / GitHub Packages only

The npm package is configured to publish to a private registry with restricted access. Public users cannot install it.

- `packages/mcp/package.json:22-24` — `"registry": "https://npm.pkg.github.com"`, `"access": "restricted"`
- `packages/mcp/src/cli.ts:20` — `NPM_REGISTRY = "https://npm.pkg.github.com"` hardcoded

### 1.4 Hardcoded personal paths in source

Developer's personal filesystem paths are committed in test files:

- `packages/tool-server/test/test-breakpoint-hit.ts:8` — `/Users/pawel/Desktop/metro_test/test_app`
- `packages/tool-server/test/test-breakpoint-e2e.ts:9` — `/Users/pawel/Desktop/metro_test/test_app`

### 1.5 Internal company URLs exposed in source

Production source code contains `swmansion.com` internal backend URLs:

- `packages/tool-server/src/tools/ai/query-documentation.ts:5` — `https://radon-ai-backend.swmansion.com/`
- `packages/tool-server/src/utils/license.ts:11` — `https://portal.ide.swmansion.com`

### 1.6 Committed `.DS_Store` files

macOS metadata files are tracked in git:

- `.DS_Store` (root)
- `packages/.DS_Store`

**Fix:** `git rm --cached .DS_Store packages/.DS_Store`

### 1.7 Committed `tsconfig.tsbuildinfo` build artifact

- `packages/ui/tsconfig.tsbuildinfo` — TypeScript incremental build cache tracked in git.

**Fix:** `git rm --cached packages/ui/tsconfig.tsbuildinfo`

### 1.8 Committed `simulator-server` binary (4.8 MB)

A 4.8 MB Mach-O arm64 binary is tracked in git at the repo root. Binary blobs in git permanently bloat the repo and cannot be removed from history without a rewrite.

- `simulator-server` — Mach-O 64-bit executable arm64

**Fix:** Remove from git, distribute via releases/CDN, or use Git LFS.

---

## 2. High — Looks Unprofessional

### 2.1 Unprofessional comment with developer name

```
// DEAD FOR NOW PASTE DOES NOT WORK (FILIP)
```

- `packages/tool-server/src/tools/interactions/paste.ts:1` — All-caps rant with internal team member name.

### 2.2 Pervasive "Radon" / "radon-lite" internal codename leak (~40+ occurrences)

The product is called "Argent" publicly, but the old codename "Radon" is everywhere:

**Environment variables using `RADON_` prefix:**

| Variable | Files |
|---|---|
| `RADON_TOOLS_URL` | `packages/mcp/src/index.ts` |
| `RADON_MCP_LOG` | `packages/mcp/src/index.ts`, `cli.ts`, `scripts/install.cjs`, `scripts/observe.cjs` |
| `RADON_AUTO_SCREENSHOT` | `packages/mcp/src/auto-screenshot.ts` |
| `RADON_AUTO_SCREENSHOT_DELAY_MS` | `packages/mcp/src/auto-screenshot.ts` |
| `RADON_SIMULATOR_SERVER_DIR` | `packages/mcp/src/launcher.ts`, `packages/tool-server/src/utils/simulator-client.ts`, `license.ts`, `simulator-server.ts` |
| `RADON_SCREENSHOT_SCALE` | `packages/tool-server/src/utils/simulator-client.ts`, `screenshot.ts` |
| `RADON_AI_URL` | `packages/tool-server/src/tools/ai/query-documentation.ts` |

Note: Some env vars already use `ARGENT_` prefix (`ARGENT_AUTO_SHUTDOWN`, `ARGENT_SKIP_POSTINSTALL`), making the inconsistency even more obvious.

**Internal runtime globals:**

| Global | Files |
|---|---|
| `__radon_lite_callback` | `cdp-client.ts`, `component-tree.ts`, `inspect-at-point.ts`, `render-hook.ts`, `js-runtime-debugger.ts` |
| `__radon_lite_render_patched` | `render-hook.ts` |
| `__radon_network_log` | `network-interceptor.ts` |
| `__radon_network_installed` | `network-interceptor.ts` |
| `__radon_network_by_id` | `network-interceptor.ts` |

**Source comments and strings:**

- `packages/mcp/src/auto-screenshot.ts:64` — `"Cursor sends mcp__radon-lite__tap"`
- `packages/tool-server/src/tools/ai/query-documentation.ts` — error messages say "Radon AI backend"
- `packages/mcp/scripts/benchmark.cjs:64` — `"radon-bench-"` temp file prefix

**Test fixtures:**

- `packages/mcp/test/auto-screenshot.test.ts` — 8+ test strings use `"mcp__radon-lite__"`
- `packages/tool-server/test/network/` — multiple tests reference `__radon_network_*`
- `packages/tool-server/test/metro/cdp-client.test.ts:164` — `__radon_lite_callback`

### 2.3 "Radon Lite" / "Radon IDE" branding in UI

- `packages/ui/index.html:6` — `<title>Radon Lite</title>`
- `packages/ui/src/views/ConnectView.tsx:20` — `"Radon Lite"` heading
- `packages/ui/src/components/TokenRequiredOverlay.tsx:32` — `"Radon IDE Pro, Team, or Enterprise subscription"`
- CSS variables use `rl-` prefix (Radon Lite) throughout all UI files

### 2.4 `radon-skills` binary name in skills package

- `packages/skills/package.json:10` — `"bin": { "radon-skills": "scripts/install.js" }` — should be `argent-skills`

### 2.5 Internal design docs and RFCs shipped as source

These are internal planning/design documents, not user-facing docs:

- `docs/folder-restructure.md` — Literally titled "PR Summary — Changes for Review"
- `docs/environment-inspector-design.md` — Architecture design doc referencing `radon-ide` internals
- `docs/metro-debugger-features.md` — Internal PR guide
- `docs/research-notifications.md` — Internal research notes
- `packages/tool-server/src/tools/profiler/react/RFC-profiler-reconnect.md` — Internal RFC with branch names
- `packages/tool-server/src/utils/react-profiler/PIPELINE_DESIGN.md` — Internal pipeline design doc
- `packages/tool-server/src/utils/ios-profiler/PIPELINE_DESIGN.md` — Internal pipeline design doc

### 2.6 MCP server reports stale version `0.1.0`

- `packages/mcp/src/index.ts:119` — `{ name: "argent", version: "0.1.0" }` but `package.json` is at `0.3.1`

### 2.7 Always-on spy logging to disk (no opt-out)

`spyLog()` in `packages/mcp/src/index.ts` writes every single tool invocation (arguments + full results) to `~/.argent/mcp-calls.log` with no way to disable it. This is:

- A privacy concern (logs all user activity)
- Debug infrastructure left in production
- No opt-out mechanism

### 2.8 Manual test files with hardcoded paths and `console.log` dumps

These are developer-local manual test scripts that don't belong in a published repo:

- `packages/tool-server/test/test-breakpoint-hit.ts` — 40+ console.log calls, hardcoded `/Users/pawel/` path
- `packages/tool-server/test/test-breakpoint-e2e.ts` — 40+ console.log calls, hardcoded `/Users/pawel/` path
- `packages/tool-server/test/metro-cdp-verify.ts` — Verification script with console.log throughout

### 2.9 `.gitignore` contains junk entry

- `.gitignore:10` — `1export` is clearly an accidental entry (looks like a mistyped terminal command that ended up in the file)

### 2.10 Broken tests (wrong expected values)

In `packages/mcp/test/auto-screenshot.test.ts`:

- Line 168 expects `getAutoScreenshotDelayMs("launch-app")` to return `2000`, but `launch-app` has a base delay of `3000` and `Math.max(3000, 2000) = 3000`
- Line 173 expects `1700` for `launch-app` but actual base delay is `3000`
- Stale comments reference old delay values (`1000` for describe, `1700` for launch-app)

### 2.11 `console.log('[rn-mcp:render]')` injected into user apps

- `packages/tool-server/src/blueprints/react-profiler-session.ts:40` — Injects `console.log('[rn-mcp:render]', ...)` into the user's React Native app. Shows up in user's console with old `rn-mcp` branding.

---

## 3. Medium — Should Clean Up

### 3.1 Missing package metadata

No `license`, `repository`, `author`, `homepage`, or `keywords` in any package:

- `packages/registry/package.json`
- `packages/tool-server/package.json`
- `packages/skills/package.json`
- `packages/ui/package.json`
- `packages/mcp/package.json`

### 3.2 Missing README files in packages

None of the internal packages have their own README:

- `packages/registry/` — no README
- `packages/tool-server/` — no README
- `packages/skills/` — no README
- `packages/ui/` — no README

### 3.3 `@argent/vscode` phantom package reference

- `docs/reference.md:16` — References `@argent/vscode` as a package but this directory doesn't exist anywhere in the repo.

### 3.4 `docs/reference.md` uses stale `radon-skills` name

- `docs/reference.md:15, 183` — References `radon-skills` CLI instead of `argent`

### 3.5 Typos in tool descriptions (user-facing)

- `packages/tool-server/src/tools/workspace/gather-workspace-data.ts:28` — `DELAGATED` → "DELEGATED"
- `packages/tool-server/src/tools/workspace/gather-workspace-data.ts:30` — `environemnt` → "environment"
- `packages/tool-server/src/tools/simulator/stop-metro.ts:25` — `desctructive` → "destructive"

### 3.6 Typos in skills and rules

- `packages/skills/rules/argent.md:34` — `informaiton` → "information"
- `packages/skills/rules/argent.md:44` — `succesful` → "successful", `preffered` → "preferred"
- `packages/skills/rules/argent.md:44` — Missing space: `describe`and`
- `packages/skills/agents/environment-inspector.md:33` — `informaiton` → "information"
- `packages/mcp/agents/environment-inspector.md:32` — `informaiton` → "information"

### 3.7 Skills reference non-existent skill

- `packages/skills/skills/react-native-app-workflow/SKILL.md:233` — References `simulator-screenshot` skill which doesn't exist
- `packages/skills/skills/test-ui-flow/SKILL.md:78` — Same reference

### 3.8 Screenshot scale default discrepancy

- `packages/tool-server/src/tools/interactions/screenshot.ts:18` — Tool description says "Defaults to ... 0.5"
- `packages/tool-server/src/utils/simulator-client.ts:7` — Actual default is `0.3`

### 3.9 Developer scripts shipped in npm package

`packages/mcp/package.json` includes `"scripts/"` in the `files` array, meaning ALL scripts ship to end users:

- `scripts/bundle-tools.cjs` — Build-time-only script with hardcoded monorepo paths
- `scripts/benchmark.cjs` — Developer benchmarking tool referencing `claude` CLI
- `scripts/observe.cjs` — Developer log observation tool

### 3.10 `console.log`/`console.error` in production code

While some are acceptable for CLI tools, several are in library/server code:

- `packages/tool-server/src/index.ts` — 6 console.log/error calls on startup
- `packages/tool-server/src/utils/idle-timer.ts:24` — console.log on shutdown
- `packages/tool-server/src/utils/license.ts:62` — console.error on keychain failure
- `packages/tool-server/src/blueprints/simulator-server.ts:99` — stderr forwarding
- `packages/ui/src/adapters/standalone.ts:30` — `console.debug('[StandaloneAdapter] send', msg)`

### 3.11 Section numbering gaps in skills

- `packages/skills/skills/ios-profiler/SKILL.md` — Jumps from §2 to §4 (no §3)
- `packages/skills/skills/react-native-profiler/SKILL.md` — Starts at §2 (no §1)

### 3.12 `&` used instead of `§` for section references

- `packages/skills/skills/react-native-optimization/SKILL.md:28-30` — Uses `&1`, `&2`, `&3` instead of `§1`, `§2`, `§3`

### 3.13 Git history contains internal references

Commit messages reference the private `software-mansion-labs` org:

- Branch names like `@latekvo/fix-network-inspector`, `@latekvo/automation-scripting`, `@latekvo/migrate-db-tools-from-ide`
- Commit `6c912c1` has message "remove a dead memory" (unclear/unprofessional)

### 3.14 `RELEASING.md` is internal process documentation

Details about pushing tags, triggering workflows, `"access": "restricted"` — all assume a private GitHub Packages workflow. Not useful for public consumers, potentially confusing.

### 3.15 Duplicated `environment-inspector.md` in 3 locations

The same agent prompt exists in:

- `.claude/agents/environment-inspector.md`
- `packages/mcp/agents/environment-inspector.md`
- `packages/skills/agents/environment-inspector.md`

### 3.16 Unused `ServiceDefinition` interface exported

- `packages/registry/src/types.ts:24-29` — `ServiceDefinition` is exported but never used anywhere in the codebase. Dead public API surface.

### 3.17 Incomplete `zod-to-json-schema` converter

- `packages/registry/src/zod-to-json-schema.ts` — Only handles `ZodString`, `ZodNumber`, `ZodBoolean`, `ZodOptional`, `ZodArray`. Common types like `ZodEnum`, `ZodLiteral`, `ZodUnion`, `ZodRecord`, `ZodDefault`, `ZodNullable` silently return `{}` with no warning.

---

## 4. Low — Nice to Fix

### 4.1 `@software-mansion/argent` scope vs public release

The package name `@software-mansion/argent` in `packages/mcp/package.json` ties the package to the `software-mansion` npm org. Decide if this is the intended public name or if it needs to change.

### 4.2 `Function` type anti-pattern

`Function` type is used instead of proper typing:

- `packages/registry/src/event-emitter.ts:7` — `Set<Function>`
- `packages/ui/src/api/client.ts:128, 151-152` — `Set<Function>`, `listener: Function`

### 4.3 Wildcard CORS

- `packages/tool-server/src/http.ts:79` — `Access-Control-Allow-Origin: *`

Acceptable for local-only servers but worth documenting the security posture.

### 4.4 Hardcoded iPhone dimensions in UI

- `packages/ui/src/components/TouchSurface.tsx:5-6` — `LOGICAL_WIDTH = 393`, `LOGICAL_HEIGHT = 852` with comment "iPhone-ish"

### 4.5 WebSocket hardcodes `ws://` (no TLS support)

- `packages/ui/src/api/client.ts:238` — Always uses `ws://`, never `wss://`

### 4.6 Silent error swallowing in UI

Multiple `.catch(() => {})` in `TouchSurface.tsx` (lines 58, 64, 71, 81) and `SessionView.tsx` (line 64).

### 4.7 Duplicated teardown logic in registry

- `packages/registry/src/registry.ts` — `_handleTermination` and `_teardown` are near-identical ~40-line methods.

### 4.8 `any` types in public API

- `packages/registry/src/types.ts` — Multiple `z.ZodObject<any>` and `ToolDefinition<any, any>` in the public type surface.

### 4.9 Missing standard files for open source

- No `CONTRIBUTING.md`
- No `CODE_OF_CONDUCT.md`
- No `CHANGELOG.md`

### 4.10 `createClient` recreated on every render

- `packages/ui/src/App.tsx:129` — `createClient(serverUrl)` called directly in render body, not memoized.

### 4.11 Module-level mutable state in UI

- `packages/ui/src/components/metro/EvalConsoleTab.tsx:32` — `let nextEntryId = 0` global counter not reset on unmount.

### 4.12 Build-time script `test:cdp-verify` references test scripts with personal paths

- `packages/tool-server/package.json:12` — `"test:cdp-verify": "ts-node test/metro-cdp-verify.ts"` — the referenced script is a manual test utility.

---

## Summary

| Severity | Count | Action |
|----------|-------|--------|
| **Critical** | 8 | Must fix before public release |
| **High** | 11 | Will look unprofessional, fix before sharing |
| **Medium** | 17 | Should clean up for quality |
| **Low** | 12 | Nice to have, fix if time allows |
| **Total** | **48** | |

### Quick Win Checklist

- [ ] Add `LICENSE` file
- [ ] Remove `.DS_Store` files from git (`git rm --cached`)
- [ ] Remove `packages/ui/tsconfig.tsbuildinfo` from git
- [ ] Remove or Git-LFS the `simulator-server` binary
- [ ] Remove `1export` from `.gitignore`
- [ ] Remove the `// DEAD FOR NOW PASTE DOES NOT WORK (FILIP)` comment
- [ ] Update `publishConfig` for public access
- [ ] Rewrite README/INSTALL for public consumption
- [x] Global find-replace `RADON_` → `ARGENT_` for env vars
- [x] Rename `__radon_lite_*` and `__radon_network_*` globals
- [ ] Remove or relocate internal docs from `docs/`
- [ ] Fix hardcoded `/Users/pawel/` paths in test files
- [ ] Update MCP server version from `0.1.0` to match package version
- [x] Rename `radon-skills` bin to `argent-skills`
- [x] Decide on "Radon Lite" vs "Argent" branding in UI (UI package removed)
