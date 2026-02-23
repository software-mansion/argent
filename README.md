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

## Development

```bash
npm run dev   # run with ts-node, no build step needed
```
