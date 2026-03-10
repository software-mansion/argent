# argent

Two HTTP surfaces: **simulator-server** is a native binary (repo root, arm64 macOS) that runs per simulator on a port (e.g. 3000) and handles device I/O — touch, key, button, rotate, paste, scroll, MJPEG stream, screenshot, recording, replay. The **tools server** is a Node app (port 3001) that lists and invokes tools (list-simulators, boot-simulator, simulator-server, launch-app, etc.); it starts simulator-server processes on demand.

## Requirements

- macOS with Xcode installed (for `xcrun simctl`)
- Node.js 18+
- The `simulator-server` binary at the **repo root** (arm64 macOS)

## Quick start (tools server only)

From the repo root:

```bash
npm install
npm run start:tool-server
```

This builds the registry dependency and starts the tools server with ts-node (live TypeScript, no build step for tool-server itself). It runs at **http://localhost:3001**. List tools and invoke them:

```bash
# List tools and their schemas
curl http://localhost:3001/tools

# Example: list booted simulators
curl -X POST http://localhost:3001/tools/list-simulators -H "Content-Type: application/json" -d '{}'
```

For the full app (tools API + web UI), see **Running the full app** below.

## Tools server and registry

The **tool-server** package (`packages/tool-server`) exposes an HTTP API for listing and invoking tools (list-simulators, boot-simulator, simulator-server, launch-app, etc.). It is backed by the in-repo **registry** (`packages/registry`), a dependency-aware service lifecycle manager: the simulator-server process is modeled as a URN-scoped service (one instance per simulator UDID), and tools declare their service dependencies; the registry resolves and starts services on demand.

Default port is 3001. `GET /tools` lists tools with input schemas; `POST /tools/:name` invokes a tool with a JSON body. On shutdown, the server calls `registry.dispose()` to tear down all running simulator-server processes.

## Running the full app (tools API + web UI)

The simplest way — one command from the repo root:

```bash
npm install
npm run start
```

This builds the registry, then launches both the tools server (ts-node, port 3001) and the UI dev server (Vite, port 5173) concurrently via `concurrently`.

If you prefer separate terminals (e.g. to see logs independently):

**Terminal 1 — tools server** (API at **http://localhost:3001**):

```bash
npm run start:tool-server
```

**Terminal 2 — frontend** (Vite at **http://localhost:5173**):

```bash
npm run start:ui
```

**Open the app** in a browser:

- Go to **http://localhost:5173**
- On the Connect screen, the default server URL is **http://localhost:3001** (or use `?serverUrl=http://localhost:3001` in the URL). Click **Connect**.
- Pick a simulator (list will load from the tools server), boot it if needed, then start the session to get the stream and controls.

The UI talks to the tools server for listing simulators, booting, and starting the simulator-server process; the session then uses the returned `apiUrl` / `streamUrl` for touch, stream, etc.

## Simulator-server API (native binary)

The **simulator-server** binary is normally started by the tools server when you invoke the `simulator-server` tool. When running, it listens on a port (e.g. 3000) and exposes a REST API for that simulator.

### Options (when run standalone)

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--port N` | `PORT` | `3000` | Port to listen on |
| `--replay` / `--no-replay` | `REPLAY` | `true` | Enable rolling replay buffer |
| `--show-touches` / `--no-show-touches` | `SHOW_TOUCHES` | `true` | Show touch pointer overlay |

```bash
# Examples
PORT=8080 ./simulator-server ios --id <UDID>
./simulator-server ios --id <UDID> --port 8080 --no-replay
```

### Token (Pro features)

Screenshot, screen recording, and replay require a Pro/Team/Enterprise JWT.

1. Get your machine fingerprint:
   ```bash
   curl http://localhost:3000/fingerprint
   ```
2. Activate your license key:
   ```bash
   curl -X POST http://localhost:3000/token/activate \
     -H "Content-Type: application/json" \
     -d '{"licenseKey": "<your-key>"}'
   ```
3. Pass the returned token when creating a session (`token` field), or update it later via `PUT /sessions/:id/token`.

Free-tier endpoints (touch, key, button, rotate, paste, scroll, MJPEG stream) work without a token.

### Quick reference (curl)

```bash
# Find a booted simulator
curl http://localhost:3000/simulators/running

# Create a session (use the UDID from above)
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"udid": "<UDID>", "token": "<JWT>"}'

# Open the streamUrl in a browser for a live MJPEG feed

# Take a screenshot (Pro)
curl -X POST http://localhost:3000/sessions/<id>/screenshot

# Tap the screen (normalized 0–1 coords)
curl -X POST http://localhost:3000/sessions/<id>/input/touch \
  -H "Content-Type: application/json" \
  -d '{"type": "Down", "points": [{"x": 0.5, "y": 0.5}]}'
```

An OpenAPI spec for the simulator-server API is not yet in the repo.

## Development

### Dev setup (run once)

```bash
npm install
```

### Running in dev mode

```bash
# Full app (tool-server + UI, single command):
npm run start

# Or individually:
npm run start:tool-server   # builds registry, starts tool-server with ts-node
npm run start:ui             # starts Vite dev server for the UI
```

The tool-server runs via ts-node so you get live TypeScript without a manual build step for tool-server itself. However, the `@argent/registry` package **must** be built first (the `start` and `start:tool-server` scripts handle this automatically).

### Building all packages

```bash
npm run build   # tsc --build using project references (registry, tool-server, mcp, ui, vscode)
```

### Running tests

```bash
npm test -w @argent/registry       # registry unit tests (vitest)
npm test -w @argent/tool-server    # tool-server tests (vitest)
npm test -w @argent/ui             # UI tests (vitest)
```

### MCP package

The `packages/mcp` directory (`argent` on npm) is the MCP bridge that AI assistants (Claude, Cursor) use to talk to the tools server. To build it:

```bash
npm run build -w argent   # compiles MCP TypeScript + bundles tool-server into a single CJS file
```

To pack it for distribution:

```bash
npm run pack:mcp   # builds and creates argent-<version>.tgz in the repo root
```
