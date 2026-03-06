# radon-lite

HTTP server for controlling iOS simulators. Exposes a clean REST API for humans and AI agents — touch, key, button, rotate, paste, scroll, MJPEG stream, screenshot, recording, and replay.

## Requirements

- macOS with Xcode installed (for `xcrun simctl`)
- Node.js 18+
- The `simulator-server` binary in `packages/server/` (arm64 macOS)

## Setup

```bash
npm install
npm run build
npm start
```

The server starts on `http://localhost:3000` by default.

## Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--port N` | `PORT` | `3000` | Port to listen on |
| `--replay` / `--no-replay` | `REPLAY` | `true` | Enable rolling replay buffer |
| `--show-touches` / `--no-show-touches` | `SHOW_TOUCHES` | `true` | Show touch pointer overlay |

```bash
# Examples
PORT=8080 npm start
npm start -- --port 8080 --no-replay
```

## Token (Pro features)

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

## Quick start

```bash
# 1. Find a booted simulator
curl http://localhost:3000/simulators/running

# 2. Create a session (use the UDID from step 1)
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"udid": "<UDID>", "token": "<JWT>"}'

# 3. Open the streamUrl in a browser for a live MJPEG feed

# 4. Take a screenshot (Pro)
curl -X POST http://localhost:3000/sessions/<id>/screenshot

# 5. Tap the screen (normalized 0–1 coords)
curl -X POST http://localhost:3000/sessions/<id>/input/touch \
  -H "Content-Type: application/json" \
  -d '{"type": "Down", "points": [{"x": 0.5, "y": 0.5}]}'
```

## API reference

The full OpenAPI 3.0.3 spec lives at [`packages/server/openapi.yaml`](packages/server/openapi.yaml).

Paste it into [editor.swagger.io](https://editor.swagger.io) for interactive docs, or import it into Postman via **File → Import**.

## Tools server and registry

The **tool-server** package (`packages/tool-server`) exposes an HTTP API for listing and invoking tools (list-simulators, boot-simulator, simulator-server). It is backed by the in-repo **registry** (`packages/registry`), a dependency-aware service lifecycle manager: the simulator-server process is modeled as a URN-scoped service (one instance per simulator UDID), and tools declare their service dependencies; the registry resolves and starts services on demand. Start the tools server from the tool-server package:

```bash
cd packages/tool-server && npm run build && npm start
```

Default port is 3001. `GET /tools` lists tools with input schemas; `POST /tools/:name` invokes a tool with a JSON body. On shutdown, the server calls `registry.dispose()` to tear down all running simulator-server processes.

## Running the app with frontend

To run the full app (tools API + web UI) from the terminal:

**1. Install and build (once):**

```bash
npm install
cd packages/registry && npm run build
cd ../tool-server && npm run build
```

**2. Start the tools server** (terminal 1). It serves the API at **http://localhost:3001**:

```bash
cd packages/tool-server && npm start
```

**3. Start the frontend** (terminal 2). Vite serves the UI at **http://localhost:5173**:

```bash
cd packages/ui && npm run dev
```

**4. Open the app** in a browser:

- Go to **http://localhost:5173**
- On the Connect screen, the default server URL is **http://localhost:3001** (or use `?serverUrl=http://localhost:3001` in the URL). Click **Connect**.
- Pick a simulator (list will load from the tools server), boot it if needed, then start the session to get the stream and controls.

The UI talks to the tools server for listing simulators, booting, and starting the simulator-server process; the session then uses the returned `apiUrl` / `streamUrl` for touch, stream, etc.

## Development

```bash
npm run dev   # run with ts-node, no build step needed
```
