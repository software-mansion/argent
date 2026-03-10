# Simulator Setup

Set up and connect to an iOS simulator using MCP tools only.

## ⚠️ IMPORTANT: MCP Tools Only

**All simulator interactions MUST go through `mcp__argent__*` MCP tools.**
- Never use `curl`, `Bash`, or the `simulator-server` binary directly
- Never call `http://localhost:3001` directly
- Never delegate simulator tasks to sub-agents (they may lack MCP tool permissions)

## Steps

1. **Find a booted simulator**
   Use the `list-simulators` MCP tool. Pick the first result — booted devices and iPhones are listed first.
   If none are booted, use `boot-simulator` with the desired UDID.

2. **Start simulator-server for the UDID**
   Use the `simulator-server` MCP tool with the UDID (and optionally a JWT token for Pro features).
   This returns `{ apiUrl, streamUrl }`.

3. **Verify connection**
   The `streamUrl` points to an MJPEG stream you can open in a browser.
   All interaction tools (`tap`, `swipe`, `gesture`, etc.) will auto-start the server if needed.

## Notes

- All tools auto-start `simulator-server` if not already running (without a token)
- For screenshot/recording, pass a JWT token to `simulator-server` or `screenshot` directly
- UDIDs look like: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`
