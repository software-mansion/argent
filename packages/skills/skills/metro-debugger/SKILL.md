---
name: metro-debugger
description: Debug a React Native app via Metro CDP using argent debugger tools. Use when connecting to Metro, setting breakpoints, pausing JS execution, inspecting React components, reading console logs, or evaluating JavaScript in the app runtime.
---

## 1. Prerequisites

The debugger requires **Metro dev server running** (default `localhost:8081`) and **a React Native app connected to Metro** (at least one CDP target). Verify via `debugger-status`.

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

| Tool                                                   | Purpose                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `debugger-set-breakpoint`                              | Set breakpoint by source file and line (optional condition).                          |
| `debugger-remove-breakpoint`                           | Remove breakpoint by breakpointId.                                                    |
| `debugger-pause` / `debugger-resume` / `debugger-step` | Pause JS execution; resume after pause or breakpoint; step over/into/out when paused. |

### Inspection & console

| Tool                                                | Purpose                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `debugger-component-tree`                           | Full React fiber tree (names, depth, bounding rects, tap coordinates).                                           |
| `debugger-inspect-element`                          | Inspect at (x, y): component hierarchy with source file:line and code fragment. See `references/source-maps.md`. |
| `debugger-log-registry`                             | Get log summary (counts, clusters, file path). Then use `Grep`/`Read` on the JSONL file for details.            |
| `debugger-console-listen`                           | Stream console messages in real-time via WebSocket.                                                              |
| `debugger-evaluate`                                 | Run a JS expression in the app runtime.                                                                          |

---

## 3. Component Inspection

### `debugger-component-tree` vs `debugger-inspect-element`

|          | `debugger-component-tree`                                              | `debugger-inspect-element`                                      |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Best for | Layout overview; finding tap targets; user-defined component hierarchy | Identifying a visible element and tracing it to its source file |
| Use when | "What's on screen and where?"                                          | "What component is this and where is it defined?"               |

Both can point to source files, but `inspect-element` is purpose-built for source tracing. `component-tree` is for orientation and tap-target discovery.

### `includeSkipped` guidance

Set to `true` only when debugging filter behavior — e.g., an expected component is missing from output, or you need to inspect a very specific branch of the tree (not just an overview).

> **Warning:** Output can be very large. Always combine with `maxNodes` and increase it incrementally (e.g., start at 50, then grow). Do not use `includeSkipped` without `maxNodes` on large apps.

---

## 4. Golden Rules

1. **`debugger-status` first when something fails** — it runs discovery, connection, and returns diagnostics.
2. **"No CDP targets" → get the app to connect to Metro** — use `restart-app` on simulator, then retry `debugger-status`.
3. **Never assume one failure is permanent** — follow recovery steps before asking the user. For starting Metro and full failure recovery, see `react-native-app-workflow` and `references/failure-scenarios.md`.

---

## 5. Reading Console Logs (Log Registry)

Logs are written to a JSONL file on disk. Use the **log-registry → grep** pattern instead of reading logs inline.

### Workflow

1. **Call `debugger-log-registry`** — returns: `file` (JSONL path), `totalEntries`, `byLevel`, `clusters` (top message groups with counts, grep patterns, and source file info), `grepTips`
2. **Search the file** using `Grep` or `Read` with patterns from the response.
3. **For real-time streaming** (UI clients), use `debugger-console-listen` — returns a WebSocket URL.

> **Large log files:** If `totalEntries` exceeds 10 000, delegate the grep exploration to an `Explore` subagent — pass it the file path, the entry format, and the patterns you need.

### JSONL entry format

Each line is a JSON object with these fields:

| Field | Type | Example / Notes |
|---|---|---|
| `marker` | string | `"[L:42]"` — unique grep anchor |
| `id` | number | Sequential |
| `timestamp` | string | ISO 8601, e.g. `"2026-03-17T14:30:00.000Z"` |
| `level` | string | `"log"` \| `"warn"` \| `"error"` \| `"info"` \| `"debug"` |
| `message` | string | Formatted console args |
| `args` | array | `[{ type, value?, description? }]` |
| `stackTrace` | object? | `{ callFrames: [{ functionName, scriptId, url, lineNumber, columnNumber }] }` |
| `byteOffset` | number | Byte position in file for seeking |

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
| Console log overview          | `debugger-log-registry` (summary + JSONL file path for `Grep`/`Read`)  |
| Real-time console stream      | `debugger-console-listen`                                               |
| Evaluate JS                   | `debugger-evaluate`                                                     |
