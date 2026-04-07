# Argent

MCP server for iOS Simulator control — tap, swipe, screenshot, profile, and debug from your AI assistant.

## Requirements

- macOS with Xcode installed
- Node.js 18 or later
- An iOS Simulator (booted via Xcode or `xcrun simctl`)

## Installation

Argent is distributed as `@swmansion/argent` via [GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

### 1. Authenticate with GitHub Packages

Add the following to your global `~/.npmrc` (create it if it does not exist), replacing `<GITHUB_PAT>` with a Personal Access Token that has the `read:packages` scope:

```ini
@swmansion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_PAT>
```

> If your organisation enforces SSO, authorise the token for `software-mansion` after creating it.

### 2. Install and initialise

```bash
npx @swmansion/argent init
```

This installs the package globally, registers the MCP server with your editor, and copies skills, rules, and agents into your workspace.

Alternatively:

```bash
npm i -g @swmansion/argent
argent init
```

### Installing from a tarball

If you have a pre-built `.tgz` (e.g. from CI or `npm pack`), no registry auth is needed:

```bash
npx @swmansion/argent init --from ./swmansion-argent-<version>.tgz
```

## Supported editors

`argent init` auto-detects and configures the MCP server for:

- Claude Code
- Cursor
- VS Code
- Windsurf
- Zed
- Gemini CLI
- Codex CLI

## CLI reference

| Command         | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| `argent init`   | Install globally and configure MCP server in the current workspace                   |
| `argent update` | Pull the latest version and refresh workspace configuration files                    |
| `argent remove` | Unregister the MCP server and uninstall (`--prune` also removes skills/rules/agents) |
| `argent mcp`    | Start the MCP stdio server directly (used internally by editors)                     |

## `describe` tool behavior

The `describe` tool now inspects a native-devtools-connected app and returns a normalized accessibility tree in the same coordinate space as tap/swipe tools.

- If `bundleId` is omitted, `describe` auto-targets a safely identifiable connected foreground app when possible.
- If the app you want is backgrounded or auto-targeting is ambiguous, provide `bundleId` explicitly.
- If native devtools are not yet injected into the target app, call `restart-app` and retry.
- `describe` is app-scoped, not simulator-wide. For visible Home/system UI, use `screenshot` to inspect the screen state.

## License

The "Argent" project utilizes a mixed licensing model to provide open-source accessibility while protecting specific proprietary binary components.

### Source Code

The vast majority of the source code (business logic, scripts, interfaces, etc.) is released under the **Apache License 2.0**. You can find the full text of the license in the <LICENSE> file. You are free to use, modify, and distribute this portion of the project in accordance with the terms of the Apache 2.0 license.

### Proprietary Binary Components

Certain elements of the project are provided exclusively as compiled binary files (typically located in the `/bin` or `/libs` directories).

- **Files:**
  - `bin/simulator-server`
  - `node_modules/@argent/native-devtools-ios/dylibs/libInjectionBootstrap.dylib`
  - `node_modules/@argent/native-devtools-ios/dylibs/libKeyboardPatch.dylib`
  - `node_modules/@argent/native-devtools-ios/dylibs/libNativeDevtoolsIos.dylib`
- **Status:** These files are **NOT** Open Source software.
- **Terms:** They are the intellectual property of Software Mansion S.A. and are licensed solely for use in conjunction with this project. Decompiling, reverse engineering, disassembling, or redistributing these binary files outside the scope of this project without explicit written permission is strictly prohibited.

By using or contributing to this project, you acknowledge and agree to this mixed licensing structure.
