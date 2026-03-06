# Simulator Screenshot

Take a screenshot of the iOS simulator screen and display it.

## Steps

1. **Get the simulator UDID** — use `list-simulators` if you don't have it already.

2. **Take a screenshot**
   Use the `screenshot` tool:
   ```json
   { "udid": "<UDID>" }
   ```
   With optional rotation:
   ```json
   { "udid": "<UDID>", "rotation": "LandscapeLeft" }
   ```

3. **The MCP adapter automatically**:
   - Fetches the PNG from the returned URL
   - Returns it as an inline image so you can see it directly

## Troubleshooting

- **Screenshot times out**: The simulator-server likely has no token. Restart it:
  ```json
  { "udid": "<UDID>", "token": "<JWT>" }
  ```
  via the `simulator-server` tool, then retry.
- **No booted simulator**: Run `boot-simulator` first.
- **Tools server not running**: `cd packages/tool-server && npm start`

## Notes

- Screenshot requires a Pro/Team/Enterprise JWT token
- The token only needs to be passed once — subsequent `screenshot` calls reuse the running process
- Returned path is the local file path on the machine running the tools server
