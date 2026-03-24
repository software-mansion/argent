---
name: simulator-setup
description: Set up and connect to an iOS simulator using argent MCP tools. Use when starting a new session, booting a simulator, getting a simulator UDID, or before any simulator interaction task.
---

## 1. Setup Steps

If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.

1. **Find a booted simulator**
   Use `list-simulators`. Pick the first result — booted iPhones are listed first.
   If none are booted, use `boot-simulator` with the desired UDID.

2. **Start simulator-server for the UDID**
   Use the `simulator-server` tool with the UDID (optionally pass a JWT token for Pro features).
   Returns `{ apiUrl, streamUrl }`.

3. **Verify connection**
   All interaction tools (`gesture-tap`, `gesture-swipe`, `gesture-custom`, etc.) auto-start the server if not already running.

## 2. Notes

- UDIDs look like: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
- For screenshots, pass a JWT token to `simulator-server` or `screenshot` directly.
- The `streamUrl` points to an MJPEG stream viewable in a browser.
