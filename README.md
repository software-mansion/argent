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
| `@argent/ui`          | `packages/ui`          | Web UI for simulator control and Metro debugging.                                                      |
| `@argent/skills`      | `packages/skills`      | Markdown skill files that instruct AI agents when/how to use Argent tools.                             |

## Requirements

- macOS with Xcode installed (for `xcrun simctl`)
- Node.js 18+
- The `simulator-server` binary at the repo root (arm64 macOS)

## Getting started

```bash
npm install
```

### Run the full app (tools server + UI)

```bash
npm run start
```

This builds the registry, then starts both the tools server (port 3001) and the Vite UI dev server (port 5173) concurrently.

Open **http://localhost:5173**, connect to the tools server (default URL is pre-filled), pick a simulator, boot it, and start a session.

To run them in separate terminals instead:

```bash
npm run start:tool-server   # API at http://localhost:3001
npm run start:ui             # UI  at http://localhost:5173
```

### Run tools server only (no UI)

```bash
npm run start:tool-server
```

Test it:

```bash
curl http://localhost:3001/tools                        # list tools
curl -X POST http://localhost:3001/tools/list-simulators \
  -H "Content-Type: application/json" -d '{}'           # invoke a tool
```

## Installing in a project

To set up argent in another project so AI assistants (Claude, Cursor) can use it:

```bash
node scripts/setup-project.cjs /path/to/project
```

This builds and packs argent, installs it as a local dependency, copies skills to `.claude/skills/`, and registers the MCP server in both `.claude/mcp.json` and `.cursor/mcp.json`. Existing configs are merged, not overwritten.

To install globally instead (configures `~/.claude.json` at the user level):

```bash
node scripts/setup-project.cjs --global
```

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
npm run build -w argent                # compile + bundle into single CJS file
npm run pack:mcp                       # build and create argent-<version>.tgz
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

### License (Pro features)

Screenshot, recording, and replay require a Pro/Team/Enterprise JWT. Free-tier endpoints (touch, keys, buttons, rotate, paste, scroll, MJPEG stream) work without one.

```bash
curl http://localhost:3000/fingerprint                    # 1. get machine fingerprint
curl -X POST http://localhost:3000/token/activate \
  -H "Content-Type: application/json" \
  -d '{"licenseKey": "<your-key>"}'                       # 2. activate license
# 3. pass returned token when creating a session, or PUT /sessions/:id/token
```

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
