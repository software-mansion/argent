# Environment Inspector — Design Summary

## What this solves

When the main agent starts working on a React Native project it has no knowledge of the project's setup. It wastes turns reading `package.json`, checking for `ios/` dirs, parsing metro configs, etc. — all of that exploration pollutes the main context window. The environment inspector handles this reconnaissance once, in isolation, and returns a compact structured report.

---

## Argent first-run setup step

**The environment inspector should be one of the first things Argent runs when starting a session on a project.** The result is persisted locally so it is automatically loaded into every future session without re-inspection, without touching git, and without modifying any project file.

### Native mechanism: auto memory

Claude Code maintains a per-project auto memory directory at:

```
~/.claude/projects/<project>/memory/
├── MEMORY.md           ← first 200 lines loaded at every session start
└── environment.md      ← full environment report (read on demand)
```

The `<project>` key is derived from the git repository root, so all worktrees and subdirectories within the same repo share one memory directory. This directory lives on the user's machine only — it is never in the workspace, never committed to git, and never touches any project file including `CLAUDE.md`.

The first 200 lines of `MEMORY.md` are loaded automatically at the start of every conversation. This is exactly the right place for environment context: concise, always-present, machine-local.

### How it works end-to-end

```
First session (memory directory empty):
  main agent runs argent-environment-inspector subagent (or inline)
  → receives structured JSON result
  → writes compact summary to MEMORY.md  (fits well within 200 lines)
  → writes full JSON to environment.md   (read on demand if detail needed)

All subsequent sessions (same machine):
  Claude Code loads first 200 lines of MEMORY.md automatically at start
  → environment context available immediately, no inspection needed
  → full detail in environment.md available via Read when needed
```

### What MEMORY.md looks like after first run

```markdown
## Project Environment (inspected 2026-03-16)
React Native 0.74, iOS + Android, Expo SDK not used.
Package manager: yarn. Metro port: 8081.
Start metro: `yarn start:local` (sets LOCAL_API=true).
Build iOS: `yarn ios` (xcodebuild Debug). Build Android: `yarn android`.
EAS: yes — profiles: development, production.
Env: react-native-config, reads .env and .env.local.
QA: eslint (`yarn lint`), tsc (`yarn tsc --noEmit`), jest (`yarn test`).
Hot reload via debugger-reload-metro tool.
Key packages: reanimated ^3, react-navigation ^6, zustand ^4.
Full detail: see environment.md in this directory.
Re-inspect if package.json or metro.config.js change.
```

This is ~15 lines — far within the 200-line limit, leaving room for Claude's own ongoing learnings alongside it.

### Subagent is read-only — main agent does the writing

The subagent runs in `permissionMode: plan` (fully read-only). It cannot write files. The subagent returns the JSON to the main agent; the **main agent** writes to the memory directory.

```
subagent → returns JSON → main agent → writes ~/.claude/projects/<proj>/memory/MEMORY.md
                                     → writes ~/.claude/projects/<proj>/memory/environment.md
```

### Re-inspection trigger

The main agent re-runs the inspector (and overwrites memory) when it detects the environment has changed. The `inspected_at` timestamp in the JSON is compared against the mtime of `package.json`, `metro.config.js`, and `eas.json`. If any of those are newer than `inspected_at`, re-inspect.

### What the main agent's instructions should say

In Argent's built-in system prompt or Argent's distributed `~/.claude/CLAUDE.md` entry:

```
At session start on any React Native project:
1. Check auto memory (MEMORY.md) for a "Project Environment" section.
2. If present and not stale (package.json unchanged since inspected_at),
   use it as environment context for all tasks.
3. If absent or stale, run the argent-environment-inspector subagent, then write
   the compact summary to MEMORY.md and the full JSON to environment.md
   in ~/.claude/projects/<project>/memory/.
```

### Why not CLAUDE.md @import

The project's `CLAUDE.md` is committed to git and shared with the team. Modifying it would either add machine-specific information to a shared file, or require every machine to independently add the import. Auto memory is the correct tool for machine-local, per-project persistent context. It also coexists with whatever `CLAUDE.md` the project already has — no interference.

---

## Final architecture (simplified)

### Primary path — Claude Code (subagents supported)

```
main agent
  └─ delegates to → argent-environment-inspector subagent  (Haiku, plan mode)
                        │ 1. check project memory — if valid, return cached result
                        │ 2. if not cached: call gather-workspace-data MCP tool
                        │    returns raw file snapshot
                        ▼
                        subagent continues with Read / Grep / Glob / Bash
                        to fill gaps, explore non-obvious locations,
                        describe build scripts, find QA and feedback-loop tooling, etc.
                              │
                              ▼
                        structured JSON → save to memory → back to main agent
                        (single result block, all intermediate turns invisible)
```

### Fallback path — Cursor / environments without subagent support

The main agent is told (via the subagent's description) that if it cannot delegate to `argent-environment-inspector`, it should run the same checklist steps itself in the main thread using `gather-workspace-data` as the first call.

No subprocess spawning, no Anthropic SDK dependency, no `claude` CLI detection. Simple.

---

## What gets built

| File | Purpose |
|---|---|
| `.claude/agents/argent-environment-inspector.md` | Subagent definition — Haiku, plan mode, `memory: project`, mandates `gather-workspace-data` as first call when not cached |
| `packages/tool-server/src/utils/workspace-reader.ts` | Shared utility — deterministic file snapshot (package.json, metro config, app.json, eas.json, lockfiles, .env* files, tool versions) |
| `packages/tool-server/src/tools/interactions/gather-workspace-data.ts` | MCP tool wrapping workspace-reader; used by subagent as step 1, callable by main agent directly in fallback |
| `packages/tool-server/src/utils/setup-registry.ts` | Register the new tool |

The `inspect-environment` subprocess-based tool is **dropped**.

---

## Subagent configuration

```yaml
---
name: argent-environment-inspector
description: >
  Inspects a React Native project's environment and returns structured JSON covering
  platform support, build and startup commands, Metro config, env resolution, key
  packages, QA/feedback-loop tooling, and Argent-specific workflow commands.
  Use proactively at session start or before any build/run/debug task.
  If subagent delegation is not available, run the steps in the main thread instead.
  The main agent is responsible for persisting the result to .claude/project-environment.md.
model: haiku
permissionMode: plan
maxTurns: 25
---
```

Key system prompt rules:
1. First action is always `gather-workspace-data`.
2. Use Read/Glob/Grep/Bash to explore beyond the snapshot (non-obvious script folders, CI config, QA tooling, custom toolchains, Makefile targets, scripts/ directory, etc.).
3. Populate all fields including `argent_workflow` and `quality_control`.
4. Return only the JSON block — no prose. The main agent handles persistence.

---

## Output schema

```json
{
  "is_react_native": true,
  "is_ios": true,
  "is_android": true,
  "is_expo": false,
  "is_web": false,

  "startup_commands": [
    { "command": "npm run start:local", "context": "sets LOCAL_API=true; reads .env.local" }
  ],
  "build_commands": [
    { "command": "npm run ios", "platform": "ios", "context": "xcodebuild Debug scheme via community CLI" },
    { "command": "npm run android", "platform": "android", "context": "gradle assembleDebug" }
  ],

  "argent_workflow": {
    "start_metro": "npm run start:local",
    "build_ios": "npm run ios",
    "build_android": "npm run android",
    "notes": "Always start metro first; iOS build expects simulator UUID passed via --simulator flag. Use 'npm run ios -- --simulator=\"iPhone 16\"' for a specific device."
  },

  "configs": {
    "metro_config": "metro.config.js",
    "babel_config": "babel.config.js",
    "app_config": "app.json",
    "tsconfig": "tsconfig.json",
    "launch_config": ".vscode/launch.json"
  },
  "metro_port": 8081,

  "env_resolution": {
    "env_files": [".env", ".env.local"],
    "strategy": "react-native-config",
    "notes": "Variables accessed via Config.API_URL from react-native-config; .env.local is gitignored and contains secrets"
  },

  "key_packages": {
    "react-native-reanimated": "^3.0.0",
    "react-navigation": "^6.1.0",
    "redux": null,
    "zustand": "^4.4.0"
  },

  "package_json": {
    "name": "MyApp",
    "version": "1.0.0",
    "scripts_summary": ["start", "start:local", "ios", "android", "test", "lint"]
  },

  "bundler": "metro",

  "terminal_tools": {
    "package_manager": "yarn",
    "pod_available": true,
    "expo_cli": false,
    "eas_cli": true
  },

  "cloud_build": {
    "eas": true,
    "eas_profiles": ["development", "production"]
  },

  "quality_control": {
    "linting": {
      "eslint": true,
      "eslint_config": ".eslintrc.js",
      "run_command": "yarn lint",
      "fix_command": "yarn lint --fix"
    },
    "formatting": {
      "prettier": true,
      "prettier_config": ".prettierrc",
      "run_command": "yarn format"
    },
    "type_checking": {
      "typescript": true,
      "strict_mode": true,
      "run_command": "yarn tsc --noEmit"
    },
    "unit_tests": {
      "jest": true,
      "jest_config": "jest.config.js",
      "run_command": "yarn test",
      "watch_command": "yarn test --watch",
      "coverage_command": "yarn test --coverage"
    },
    "e2e_tests": {
      "detox": false,
      "maestro": false
    },
    "feedback_loop_tools": {
      "metro_hot_reload": true,
      "react_devtools": false,
      "flipper": false,
      "storybook": false,
      "notes": "Primary feedback loop: Metro hot reload via debugger-reload-metro tool. Type errors surfaced via tsc --noEmit. Lint on save via ESLint VSCode extension."
    }
  },

  "additional_notes": "This project uses a custom Makefile for bootstrap (make setup runs pod install + env copy). The scripts/ directory contains migration helpers and a seed-data script used only in development. Husky pre-commit hook runs lint-staged (eslint + prettier on staged files only).",

  "needs_user_input": false,
  "missing_information": [],

  "inspected_at": "2026-03-16T10:24:00Z"
}
```

### Schema field guide

| Field | What the subagent should determine |
|---|---|
| `argent_workflow` | The exact commands to use with Argent for metro start, iOS build, Android build. Include any flags, env vars, or ordering constraints. |
| `quality_control.feedback_loop_tools` | Tools that give the agent rapid feedback: hot reload, type checker, test runner in watch mode, Storybook. Note which are actually usable vs just installed. |
| `additional_notes` | Free-form string. Anything relevant that does not fit the structured fields: Makefile targets, scripts/ directory contents, monorepo quirks, bootstrap steps, pre-commit hooks, unusual tooling. |
| `missing_information` | List of things the agent could not determine and may need to ask the user about (e.g. required .env values not in the repo, signing configuration, team-specific tools). |

---

## Quality control and feedback loops — what the subagent should look for

Beyond the obvious (ESLint, Jest config), the subagent should actively look for:

**Immediate feedback tools (agent can trigger these during a task):**
- `tsc --noEmit` — instant type error feedback after edits, no build needed
- `eslint --fix` — auto-fixable lint errors
- `jest --testPathPattern <file>` — run a single test file in isolation
- `yarn test --watch` — reactive test runner
- Metro hot reload (via `debugger-reload-metro` Argent tool) — JS changes visible in < 1s

**Slower validation tools (agent runs at end of a task):**
- Full `jest` run
- Detox / Maestro E2E
- `eas build --local` for native validation

**Indicators to check:**
- `scripts/` directory at project root — often contains custom validation scripts
- `Makefile` targets — look for `lint`, `test`, `typecheck`, `check`, `validate`
- `package.json` scripts named `check`, `verify`, `ci`, `precommit`, `prepush`
- `.husky/` directory — shows which hooks run and what they execute
- `lint-staged` config in `package.json` or `.lintstagedrc` — shows what runs on commit
- CI config files: `.github/workflows/`, `.circleci/`, `bitrise.yml`, `.gitlab-ci.yml` — the CI steps are the ground truth for what "passing" means

---

## Key decisions made during design

### Why a subagent and not a skill

A SKILL.md runs in the main agent's context — it just gives the agent instructions to follow. The agent then does the file reads itself, and every intermediate step pollutes the main context window. A subagent runs in its own context window: the main agent sees only the final JSON block as a tool result.

### Why `gather-workspace-data` as a separate MCP tool

A subagent starts cold — it has no knowledge of the project. Without the MCP tool it would open 8–10 files one by one just to establish baseline facts. `gather-workspace-data` collapses that into a single turn, letting the subagent immediately focus on interpretation and deeper exploration. It also serves as the entry point for the fallback path (main agent calls it directly).

### Why the subprocess / SDK approach was dropped

Two approaches were considered for making the inspection work in non-subagent environments without user-provided credentials:

1. **MCP Sampling** (`sampling/createMessage`) — the MCP spec requires human-in-the-loop approval for each sampling request. Surfaces a dialog per call. Not invisible.

2. **`claude` CLI subprocess** (the `humanlayer/claudelayer` / `shinpr/sub-agents-mcp` pattern) — spawns `claude -p <prompt> --model haiku` using the existing `claude` binary auth. Works in Claude Code environments. But too environment-dependent: not available in Cursor, JetBrains, or any setup without Claude Code installed.

**Decision:** drop the MCP-tool-as-subprocess idea entirely. In non-subagent environments the main agent simply runs the same steps in its own thread. The context overhead is manageable because `gather-workspace-data` still collapses the file-reading into one tool call.

### Model choice

`haiku` — same reasoning the built-in Explore subagent uses. File reading and pattern recognition requires no heavy reasoning. Fast and cheap. Configurable via `CLAUDE_CODE_SUBAGENT_MODEL` or by editing the frontmatter.

### Heuristics sourced from radon-ide VSCode extension

The detection signals in `gather-workspace-data` mirror what the Radon IDE extension does programmatically:

| Signal | Source in radon-ide |
|---|---|
| App root detection | `findAppRootCandidates()` — looks for `metro.config.js`, `app.json`, `app.config.js` |
| iOS | `checkNativeDirectoryExists()` — `ios/` + `.xcworkspace` or `Podfile` |
| Android | `android/` + `build.gradle` |
| Expo Go vs dev client | No native dirs + `app.json` + expo in deps |
| Package manager | Lockfile detection: `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb` |
| EAS | `eas.json` + `isEasCliInstalled()` from `easCommand.ts` |
| Metro port | `server.port` in `metro.config.js` |

### Distribution

- **Subagent** (`.claude/agents/`): lives in user projects. Future path: ship via Argent plugin `agents/` directory so Claude Code users get it automatically on install.
- **MCP tool** (`gather-workspace-data`): distributed with the existing tool-server, available to all MCP clients immediately.

---

## References consulted

- [Claude Code subagents docs](https://docs.anthropic.com/en/docs/claude-code/subagents) — confirmed subagents inherit all MCP tools; subagents cannot spawn other subagents
- [Claude Code memory docs](https://docs.anthropic.com/en/docs/claude-code/memory) — CLAUDE.md loaded in full every session; `@import` syntax for file injection; auto memory MEMORY.md first 200 lines loaded every session (machine-local); `.claude/rules/` for modular unconditional rules
- [Claude Code model config docs](https://docs.anthropic.com/en/docs/claude-code/model-config) — `haiku` alias, `CLAUDE_CODE_SUBAGENT_MODEL` env var
- [`humanlayer/claudelayer`](https://github.com/humanlayer/claudelayer) — `claude -p` subprocess pattern (evaluated and dropped)
- [`shinpr/sub-agents-mcp`](https://github.com/shinpr/sub-agents-mcp) — general subagent launcher via `claude -p` (evaluated and dropped)
- [MCP Sampling spec](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling) — human-in-the-loop requirement disqualifies it for invisible use
- `radon-ide/packages/vscode-extension/src/` — `dependency/`, `builders/`, `utilities/extensionContext.ts` for heuristics reference
