---
name: simulator-screenshot
description: Take a screenshot of an iOS simulator screen using argent. Use when capturing the initial screen state, checking state after a delay, or when no interaction tool was just called.
---

# Simulator Screenshot

## When to Use

Call `screenshot` when you need to see the simulator screen **without performing an action first** — e.g. to capture the initial state, or to check state after a delay. After calling interaction tools (`tap`, `swipe`, `launch-app`, etc.), you already receive a screenshot in that tool's response; no separate call is needed unless the auto-attached image shows a transitional or loading frame.

## Steps

1. **Get the simulator UDID** — use `list-simulators` if you don't have it already.

2. **Take a screenshot**
   ```json
   { "udid": "<UDID>" }
   ```
   With optional rotation:
   ```json
   { "udid": "<UDID>", "rotation": "LandscapeLeft" }
   ```

3. The MCP adapter automatically fetches the PNG from the returned URL and returns it as an inline image.

## Troubleshooting

- **Screenshot times out**: The simulator-server likely has no token. Restart it via the `simulator-server` tool:
  ```json
  { "udid": "<UDID>", "token": "<JWT>" }
  ```
  Then retry.
- **No booted simulator**: Run `boot-simulator` first.
- **Tools server not running**: `cd packages/tool-server && npm start`

## Notes

- Screenshot requires a Pro/Team/Enterprise JWT token
- The token only needs to be passed once — subsequent `screenshot` calls reuse the running process
- Returned path is the local file path on the machine running the tools server
