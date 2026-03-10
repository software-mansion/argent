---
name: metro-debugger
description: Debug a React Native app running on iOS simulator via Metro CDP using argent debugger tools. Use when connecting to Metro, setting breakpoints, pausing JS execution, inspecting React components, reading component tree reading console logs, or evaluating JavaScript in the app runtime.
---

# Metro and Debugger

## Critical: MCP Tools Only

**Prefer usage of `mcp__argent__debugger-*` MCP tools for Metro and debugger actions.** When recovering connectivity, you may also use simulator tools `mcp__argent__restart-app` and `mcp__argent__launch-app`. You can `curl` the metro server when needed to get information that MCP tools do not provide.

- When delegating to a sub-agent, ensure it has permission to use the MCP server.

## Autonomy

**Act first, ask only when necessary.** Prefer starting Metro, restarting the app, and retrying yourself. Only ask the user when:

- You need information only they have (e.g. which project root or app to use, or a non-default port).
- Recovery failed after you tried (e.g. you started Metro but the app still has no CDP targets).
- The user has explicitly said not to start servers or run commands.

If the task does not say "do not start Metro" or "ask before starting servers", start Metro yourself when it is not running, then retry the debugger tool. If you started a metro server, inform the user, telling which port it is running on and which app it is serving.

Starting the metro by yourself:

- inspect the project structure and determine whether there are metro / app starting commands
- if not default to standard commands (`npx react-native start`, `npx expo start`)
- if that does not resolve the problem, tell the user what is the problem and ask for clarification how the server should be started.

## Prerequisites

The debugger can connect only when:

1. **Metro dev server is running** - by default on localhost:8081, dependent on workspace configuration.
2. **A React Native app is running and connected to Metro** - at least one CDP target. Checkable via http://CONFIGURED_HOST:PORT/json/list and checking whether array of objects is not empty. By default: http://CONFIGURED_HOST:PORT/json/list.

## Tool Overview

All debugger tools accept `port` (default 8081). The debugger tools establsih the debugger connection by themselves. To do so manually use `mcp__argent__debugger-connect` tool.

### Connect and diagnostics

| Tool                                | Purpose                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `mcp__argent__debugger-connect` | Connect to Metro CDP. Returns projectRoot, deviceName, connected. Trigger manually when tools fail to connect by themselves. |
| `mcp__argent__debugger-status`  | Connect plus loadedScripts, sourceMapReady. **Use for diagnostics when something fails.**             |

### Recovery and reload

| Tool                                     | Purpose                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__argent__debugger-reload-metro` | Ask Metro to reload all connected apps (like pressing "r" in the Metro terminal). Use when already connected and you want to reload JS without killing the app. **Requires at least one CDP target** — it does not fix "no CDP targets". |
| `mcp__argent__restart-app`           | Simulator only. Terminate and relaunch the app by UDID and bundleId. Use when the app is not connected to Metro so that after relaunch it connects; then retry `debugger-connect` or `debugger-status`.                                  |

### Breakpoints and execution

| Tool                                          | Purpose                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `mcp__argent__debugger-set-breakpoint`    | Set breakpoint by **source** file and line (optional condition). Source maps resolve to bundle. |
| `mcp__argent__debugger-remove-breakpoint` | Remove breakpoint by breakpointId.                                                              |
| `mcp__argent__debugger-pause`             | Pause JS execution.                                                                             |
| `mcp__argent__debugger-resume`            | Resume after pause or breakpoint.                                                               |
| `mcp__argent__debugger-step`              | Step over / step into / step out when paused.                                                   |

### Inspection and console

| Tool                                        | Purpose                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__argent__debugger-component-tree`  | Full React fiber tree (names, depth, bounding,rects).                                                                                          |
| `mcp__argent__debugger-inspect-element` | Inspect at (x, y): component hierarchy with source file:line and code fragment. See `references/source-maps.md` for source resolution details. |
| `mcp__argent__debugger-console-logs`    | Get console messages.                                                                                                                          |
| `mcp__argent__debugger-console-listen`  | Stream console messages.                                                                                                                       |
| `mcp__argent__debugger-evaluate`        | Run a JS expression in the app runtime.                                                                                                        |

## Don't Get Stuck: Golden Rules

1. **Use `debugger-status` first when something fails** — it runs discovery and connection like connect, and returns projectRoot, deviceName, connected, loadedScripts.
2. **"No CDP targets" always means get the app to connect to Metro** — on simulator, **`restart-app`** is the right tool; then retry `debugger-status`.
3. **Never assume one failure is permanent** — follow the recovery steps (start Metro, restart app, retry) yourself before asking the user.

For full failure recovery steps, see `references/failure-scenarios.md`.

## Quick Reference: Action to Tool

| Action                                         | Tool                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Check connection / diagnose                    | `debugger-status`                                                       |
| Connect to Metro CDP                           | `debugger-connect`                                                      |
| Reload JS (already connected)                  | `debugger-reload-metro`                                                 |
| Relaunch app on simulator (reconnect to Metro) | `restart-app`                                                           |
| Set breakpoint by file:line                    | `debugger-set-breakpoint`                                               |
| Remove breakpoint                              | `debugger-remove-breakpoint`                                            |
| Pause / resume / step                          | `debugger-pause`, `debugger-resume`, `debugger-step`                    |
| Inspect component at point                     | `debugger-inspect-element`                                              |
| Full component tree                            | `debugger-component-tree`                                               |
| Console logs / evaluate                        | `debugger-console-logs`, `debugger-console-listen`, `debugger-evaluate` |
