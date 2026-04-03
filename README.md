# Argent

Argent has two HTTP surfaces:

- **Tools server** — Node/Express app (port 3001) that lists and invokes tools via a registry. Manages simulator lifecycle, debugger connections, and all tool logic.
- **Simulator server** — Native arm64 macOS binary (repo root) that runs one process per simulator. Handles device I/O: touch, keys, buttons, rotation, paste, scroll, MJPEG stream, screenshots, recording.

The tools server spawns simulator-server processes on demand. The UI and MCP bridge both talk to the tools server; the tools server talks to simulator-server instances.

## Packages

| Package               | Path                   | Purpose                                                                                                |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `@argent/registry`    | `packages/registry`    | Core library: dependency-aware service lifecycle, blueprints, tools, URNs. No HTTP or simulator logic. |
| `@argent/tool-server` | `packages/tool-server` | HTTP API over the registry (`GET /tools`, `POST /tools/:name`). Registers all blueprints and tools.    |
| `@argent/mcp`         | `packages/mcp`         | MCP bridge — exposes all tools to AI assistants (Claude, Cursor) via Model Context Protocol.           |
| `@argent/skills`      | `packages/skills`      | Markdown skill files that instruct AI agents when/how to use Argent tools.                             |

## Requirements

- macOS with Xcode installed (for `xcrun simctl`)
- Node.js 18+
- The `simulator-server` binary at the repo root (arm64 macOS)

## Getting started

```bash
npm install
```

### Run the tools server

```bash
npm run start
```

This builds the registry, then starts the tools server on port 3001.

```bash
npm run start:tool-server   # equivalent alias
```

Test it:

```bash
curl http://localhost:3001/tools                        # list tools
curl -X POST http://localhost:3001/tools/list-simulators \
  -H "Content-Type: application/json" -d '{}'           # invoke a tool
```

## Installing in a project

The `argent` package is distributed via [GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) under the `@swmansion` scope. Because the source repository is private, you must authenticate before installing.

**Quick start** (after completing auth setup):

```bash
npx @swmansion/argent install
```

This installs the package from GitHub Packages and configures MCP servers in `.claude/mcp.json`, `.cursor/mcp.json`, and copies skills, agents, and rules into your workspace.

### VS Code launch configs

| Config                        | What it does                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Install Argent in Project** | Prompts for a folder path, then builds, installs, and configures argent in that project.                               |
| **Argent Agent Debug**        | Same as above but also opens the project in a new VS Code window and launches the tools server with debugger attached. |
| **Tools Server**              | Runs the tool-server with ts-node on port 3001.                                                                        |
| **Tools Server (built)**      | Builds first, then runs the compiled tool-server.                                                                      |
| **UI (Chrome)**               | Opens the Vite UI in Chrome.                                                                                           |
| **Full (Tools + UI)**         | Compound — starts both Tools Server and UI.                                                                            |

## Building and testing

```bash
npm run build                          # tsc --build (all packages)
npm test -w @argent/registry           # registry unit tests (vitest)
npm test -w @argent/tool-server        # tool-server tests (vitest)
```

### MCP package

```bash
npm run build -w @swmansion/argent   # compile + bundle into single CJS file
npm run pack:mcp                                  # build and create argent-<version>.tgz
```

## Simulator server API

The simulator-server binary is normally spawned by the tools server. To run it standalone:

```bash
./simulator-server ios --id <UDID>                          # defaults: port 3000, replay on, touch overlay on
./simulator-server ios --id <UDID> --port 8080 --no-replay  # custom port, replay off
```

| Flag                                   | Env var        | Default | Description           |
| -------------------------------------- | -------------- | ------- | --------------------- |
| `--port N`                             | `PORT`         | `3000`  | Listen port           |
| `--replay` / `--no-replay`             | `REPLAY`       | `true`  | Rolling replay buffer |
| `--show-touches` / `--no-show-touches` | `SHOW_TOUCHES` | `true`  | Touch pointer overlay |

### Quick reference (curl)

```bash
curl http://localhost:3000/simulators/running              # list running simulators

curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"udid": "<UDID>", "token": "<JWT>"}'               # create session

curl -X POST http://localhost:3000/sessions/<id>/screenshot  # screenshot (Pro)

curl -X POST http://localhost:3000/sessions/<id>/input/touch \
  -H "Content-Type: application/json" \
  -d '{"type":"Down","points":[{"x":0.5,"y":0.5}]}'       # tap (normalized 0-1)
```

## Further reading

See [`docs/reference.md`](docs/reference.md) for a detailed breakdown of the registry, blueprints, services, tools, and how they all connect.

## License

The "Argent" project utilizes a mixed licensing model to provide open-source accessibility while protecting specific proprietary binary components.

### Source Code

The vast majority of the source code (business logic, scripts, interfaces, etc.) is released under the **Apache License 2.0**. You can find the full text of the license in the <LICENSE.TXT> file. You are free to use, modify, and distribute this portion of the project in accordance with the terms of the Apache 2.0 license.

### Proprietary Binary Components

Certain elements of the project are provided exclusively as compiled binary files (typically located in the `/bin` or `/libs` directories).

- **Files:**
  - `packages/mcp/bin/simulator-server`
  - `packages/native-devtools-ios/dylibs/libInjectionBootstrap.dylib`
  - `packages/native-devtools-ios/dylibs/libKeyboardPatch.dylib`
  - `packages/native-devtools-ios/dylibs/libNativeDevtoolsIos.dylib`
- **Status:** These files are **NOT** Open Source software.
- **Terms:** They are the intellectual property of Software Mansion S.A. and are licensed solely for use in conjunction with this project. Decompiling, reverse engineering, disassembling, or redistributing these binary files outside the scope of this project without explicit written permission is strictly prohibited.

By using or contributing to this project, you acknowledge and agree to this mixed licensing structure.
