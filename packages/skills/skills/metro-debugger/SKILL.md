---
name: metro-debugger
description: Debug a React Native app via Metro CDP using argent debugger tools. Use when connecting to Metro, setting breakpoints, pausing JS execution, inspecting React components, reading console logs, or evaluating JavaScript in the app runtime.
---

## 1. Prerequisites

All debugging goes through argent MCP tools — only use `curl` or direct HTTP calls to Metro when the functionality is not exposed via our tool. When delegating to a sub-agent, ensure it has MCP tool permissions.

The debugger requires:

1. **Metro dev server running** — default `localhost:8081`, depends on workspace config.
2. **A React Native app connected to Metro** — at least one CDP target. Verify via `debugger-status`.

## 2. Tool Overview

All tools accept `port` (default 8081) and auto-connect to Metro. Use `debugger-connect` to connect manually when tools fail to auto-connect.

### Connect & diagnostics

| Tool               | Purpose                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `debugger-connect` | Connect to Metro CDP. Returns projectRoot, deviceName, connected.  |
| `debugger-status`  | Like connect + loadedScripts, sourceMapReady. **Use to diagnose.** |

### Reload & recovery

| Tool                    | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `debugger-reload-metro` | Reload all connected apps (like pressing "r" in Metro terminal). Needs a CDP target.     |
| `restart-app`           | Terminate and relaunch the app by UDID and bundleId. Use when app lost Metro connection. |

### Breakpoints & execution control

| Tool                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `debugger-set-breakpoint`    | Set breakpoint by source file and line (optional condition). |
| `debugger-remove-breakpoint` | Remove breakpoint by breakpointId.                           |
| `debugger-pause`             | Pause JS execution.                                          |
| `debugger-resume`            | Resume after pause or breakpoint.                            |
| `debugger-step`              | Step over / into / out when paused.                          |

### Inspection & console

| Tool                       | Purpose                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger-component-tree`  | Full React fiber tree (names, depth, bounding rects). Can be used to retrieve infomration where to tap on screen in react native apps |
| `debugger-inspect-element` | Inspect at (x, y): component hierarchy with source file:line and code fragment. See `references/source-maps.md`.                      |
| `debugger-console-logs`    | Get console messages.                                                                                                                 |
| `debugger-console-listen`  | Stream console messages in real-time.                                                                                                 |
| `debugger-evaluate`        | Run a JS expression in the app runtime.                                                                                               |

---

## 3. Autonomy

**Act first, ask only when necessary.** Start Metro, restart the app, and retry yourself. Only ask the user when:

- You need information only they have (project root, non-default port).
- Recovery failed after your attempts.
- The user explicitly asked you not to start servers.

Starting Metro yourself:

Refer to the skill `react-native-app-workflow`

## 4. Golden Rules

1. **`debugger-status` first when something fails** — it runs discovery, connection, and returns diagnostics.
2. **"No CDP targets" → get the app to connect to Metro** — use `restart-app` on simulator, then retry `debugger-status`.
3. **Never assume one failure is permanent** — follow recovery steps before asking the user.

For full failure recovery steps, see `references/failure-scenarios.md`.

---

## Quick Reference

| Action                        | Tool                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| Diagnose / check connection   | `debugger-status`                                                       |
| Connect to Metro CDP          | `debugger-connect`                                                      |
| Reload JS (already connected) | `debugger-reload-metro`                                                 |
| Relaunch app on simulator     | `restart-app`                                                           |
| Set breakpoint by file:line   | `debugger-set-breakpoint`                                               |
| Remove breakpoint             | `debugger-remove-breakpoint`                                            |
| Pause / resume / step         | `debugger-pause`, `debugger-resume`, `debugger-step`                    |
| Inspect component at point    | `debugger-inspect-element`                                              |
| Full component tree           | `debugger-component-tree`                                               |
| Console logs / evaluate       | `debugger-console-logs`, `debugger-console-listen`, `debugger-evaluate` |

## Related Skills

| Skill                       | When to use                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `react-native-app-workflow` | Starting the app, Metro setup, build issues, runtime errors |
| `simulator-setup`           | Booting and connecting a simulator                          |
| `simulator-interact`        | Tapping, swiping, typing on the simulator                   |
| `simulator-screenshot`      | Capturing the simulator screen                              |
| `react-native-profiler`     | Performance profiling, re-render analysis                   |
| `test-ui-flow`              | Interactive UI testing with screenshot verification         |
