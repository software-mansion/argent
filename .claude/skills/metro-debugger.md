# Metro and Debugger

## Critical: MCP Tools Only

**Prefer usage of `mcp__radon-lite__debugger-*` MCP tools for Metro and debugger actions.** When recovering connectivity, you may also use simulator tools `mcp__radon-lite__restart-app` and `mcp__radon-lite__launch-app`. You can `curl` the metro server when needed to get information, which tools delivered with MCP server do not provide.

- When delegating to a sub-agent, ensure it has permission to use the MCP server.

## Autonomy

**Act first, ask only when necessary.** Prefer starting Metro, restarting the app, and retrying yourself. Only ask the user when:
- You need information only they have (e.g. which project root or app to use, or a non-default port).
- Recovery failed after you tried (e.g. you started Metro but the app still has no CDP targets).
- The user has explicitly said not to start servers or run commands.

If the task does not say "do not start Metro" or "ask before starting servers", start Metro yourself when it is not running (e.g. run `npx react-native start` from the React Native project root in the background), then retry the debugger tool. If started a metro server, inform the user about in, telling which port it is running on and which app it is servering.

## Prerequisites

The debugger can connect only when:

1. **Metro dev server is running** — e.g. `npx react-native start` from the React Native project root (default port 8081).
2. **A React Native app is running and connected to Metro** — at least one CDP target. The user can confirm in the Metro terminal: a BUNDLE log when the entry point is compiled, then `LOG  Running "[AppName]"` when the app starts, and Fast Refresh activity when the WebSocket is active.

## Tool Overview

All debugger tools accept `port` (default 8081). Call `debugger-connect` first, or let any other debugger tool auto-connect.

### Connect and diagnostics

| Tool | Purpose |
|------|---------|
| `mcp__radon-lite__debugger-connect` | Connect to Metro CDP. Returns projectRoot, deviceName, connected. Call first or let other tools auto-connect. |
| `mcp__radon-lite__debugger-status` | Same as connect plus loadedScripts, sourceMapReady. **Use for diagnostics when something fails.** |

### Recovery and reload

| Tool | Purpose |
|------|---------|
| `mcp__radon-lite__debugger-reload-metro` | Ask Metro to reload all connected apps (like pressing "r" in the Metro terminal). Use when already connected and you want to reload JS without killing the app. **Requires at least one CDP target** — it does not fix "no CDP targets". |
| `mcp__radon-lite__restart-app` | Simulator only. Terminate and relaunch the app by UDID and bundleId. Use when the app is not connected to Metro so that after relaunch it connects; then retry `debugger-connect` or `debugger-status`. |

### Breakpoints and execution

| Tool | Purpose |
|------|---------|
| `mcp__radon-lite__debugger-set-breakpoint` | Set breakpoint by **source** file and line (optional condition). Source maps resolve to bundle. |
| `mcp__radon-lite__debugger-remove-breakpoint` | Remove breakpoint by breakpointId. |
| `mcp__radon-lite__debugger-pause` | Pause JS execution. |
| `mcp__radon-lite__debugger-resume` | Resume after pause or breakpoint. |
| `mcp__radon-lite__debugger-step` | Step over / step into / step out when paused. |

### Inspection and console

| Tool | Purpose |
|------|---------|
| `mcp__radon-lite__debugger-component-tree` | Full React fiber tree (names, depth, bounding rects). |
| `mcp__radon-lite__debugger-inspect-element` | Inspect at (x, y): component hierarchy with source file:line and code fragment. |
| `mcp__radon-lite__debugger-console-logs` | Get console messages. |
| `mcp__radon-lite__debugger-console-listen` | Stream console messages. |
| `mcp__radon-lite__debugger-evaluate` | Run a JS expression in the app runtime. |

## Failure Scenarios: What to Do

When a debugger tool fails, use **`debugger-status`** first to diagnose. Then match the error or situation below and act as specified. Do not retry the same failing tool repeatedly without following the recovery steps.

| Scenario | Error or situation | What to do |
|----------|--------------------|------------|
| **Metro not running** | Error contains: `Metro at port 8081 is not running (got: ...)` | **Start Metro yourself** unless the user asked you not to: scan the workspace configuration and run appropriate command used to start the application / metro server in the background (by default it is `npx react-native start` or `npx expo start` - use as fallback if cannot derive from user project), wait for it to be ready, then retry `debugger-connect` or `debugger-status`. If you don't know the project root, ask the user. Do not retry the same tool repeatedly without starting Metro first. |
| **Metro not standard** | Error contains: `Metro at port 8081 did not return X-React-Native-Project-Root header` | Something on that port is not the standard React Native Metro server. Try starting Metro yourself from the app's project root, according to command resolution stated above in the table. If you cannot determine the correct root or the problem persists, inform the user what you found and what you tried. |
| **App not connected** | Error contains: `Metro at port 8081 has no CDP targets — is a React Native app connected?` | 1) Confirm the app is running on simulator or device. 2) If simulator: use `restart-app` with the app's UDID and bundleId to relaunch so it connects to Metro. 3) Wait a few seconds for the bundle to load. 4) Retry `debugger-connect` or `debugger-status`. Do **not** use `debugger-reload-metro` to fix this — it also requires at least one target. |
| **Was connected, then tool fails** | Any debugger tool fails with a connection or disconnect error after it was working | The app may have crashed or been closed. Use `restart-app` (simulator) to relaunch the app, then call `debugger-connect` or `debugger-status` again. |
| **Breakpoint has no locations** | `debugger-set-breakpoint` returns empty `locations` | Source map not ready or file not in bundle. Wait for scripts to load (e.g. run `debugger-status` and check loadedScripts / sourceMapReady), or verify the file path and line exist in the project. |

## Don't Get Stuck: Golden Rules

1. **Use `debugger-status` first when something fails** — it runs discovery and connection like connect, and returns projectRoot, deviceName, connected, loadedScripts.
2. **"No CDP targets" always means get the app to connect to Metro** — on simulator, **`restart-app`** is the right tool; then retry `debugger-connect` or `debugger-status`.
3. **Never assume one failure is permanent** — follow the recovery steps (start Metro, restart app, retry) yourself before asking the user.

## Quick Reference: Action to Tool

| Action | Tool |
|--------|------|
| Check connection / diagnose | `debugger-status` |
| Connect to Metro CDP | `debugger-connect` |
| Reload JS (already connected) | `debugger-reload-metro` |
| Relaunch app on simulator (reconnect to Metro) | `restart-app` |
| Set breakpoint by file:line | `debugger-set-breakpoint` |
| Remove breakpoint | `debugger-remove-breakpoint` |
| Pause / resume / step | `debugger-pause`, `debugger-resume`, `debugger-step` |
| Inspect component at point | `debugger-inspect-element` |
| Full component tree | `debugger-component-tree` |
| Console logs / evaluate | `debugger-console-logs`, `debugger-console-listen`, `debugger-evaluate` |
