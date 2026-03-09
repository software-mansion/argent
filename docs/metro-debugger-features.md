# Metro Debugger Features — PR Guide

Short guide to what was added in the Metro Debugger pull request, how to use it, and how to integrate with agentic APIs (MCP, skills).

---

## What Was Added

### 1. Metro / CDP debugger service

- **JsRuntimeDebugger** blueprint: connects to a running Metro dev server (default port 8081) via Chrome DevTools Protocol (CDP).
- **Discovery & target selection**: `GET /status`, `GET /json/list`, then pick the right CDP target (Fusebox, C++ connection, or legacy).
- **Source maps**: Fetches and parses source maps from `Debugger.scriptParsed`; supports breakpoint resolution from **source file:line** to **bundle position** (required for Hermes/Metro).
- **Source resolver**: Symbolication via Metro `POST /symbolicate` for stack frames and inspect results.

### 2. Debugger tools (all under `debugger-*`)


| Tool                                                    | Purpose                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **debugger-connect**                                    | Connect to Metro CDP (port, default 8081). Call first or let other tools auto-connect. |
| **debugger-status**                                     | Connection state, project root, device name.                                           |
| **debugger-evaluate**                                   | Run JS in the app runtime (`Runtime.evaluate`).                                        |
| **debugger-set-breakpoint**                             | Set breakpoint by source file + line (uses source maps).                               |
| **debugger-remove-breakpoint**                          | Remove breakpoint by `breakpointId`.                                                   |
| **debugger-pause**                                      | Pause JS execution.                                                                    |
| **debugger-resume**                                     | Resume after pause/breakpoint.                                                         |
| **debugger-step**                                       | Step over / into / out when paused.                                                    |
| **debugger-component-tree**                             | Full React fiber tree with names, depth, bounding rects.                               |
| **debugger-inspect-element**                            | Tap-to-inspect at (x, y): component hierarchy with source file:line and code fragment. |
| **debugger-console-logs** / **debugger-console-listen** | Console message access.                                                                |


### 3. VS Code

- **`.vscode/launch.json`**: “Tools Server”, “Tools Server (built)”, “UI (Chrome)”, compound “Full (Tools + UI)”.
- **`.vscode/tasks.json`**: `start-vite`, `build-tools` for pre-launch.

---

## How to Use

### Prerequisites

- React Native app running in debug mode (simulator or device).
- Metro dev server (e.g. port 8081).
- Tools server running (e.g. `npm run dev` in repo root or “Tools Server” in VS Code).

### Basic flow

1. **Connect** (optional; other tools can trigger it):
  ```bash
   curl -X POST http://localhost:3001/tools/debugger-connect -H "Content-Type: application/json" -d '{"port": 8081}'
  ```
   Or from an agent: call the `debugger-connect` tool with `{ "port": 8081 }`.
2. **Set a breakpoint** (source file and line; column optional):
  ```json
   { "port": 8081, "file": "App.tsx", "line": 21 }
  ```
   Returns `breakpointId` and `locations`. Use `breakpointId` with `debugger-remove-breakpoint` to remove it.
3. **Run the app** until the breakpoint hits (UI will pause). Then:
  - **debugger-step** with `action`: `"stepOver"` | `"stepInto"` | `"stepOut"`.
  - **debugger-resume** to continue.
4. **Inspect UI**:
  - **debugger-inspect-element**: `{ "port": 8081, "x": 100, "y": 200 }` — returns component hierarchy with source locations and code snippets.
  - **debugger-component-tree**: `{ "port": 8081 }` — full tree with `id`, `name`, `depth`, `rect`, `isHost`, `parentIdx`.
5. **Evaluate JS** in the app:
  - **debugger-evaluate**: `{ "port": 8081, "expression": "1 + 1" }` (or any JS expression).

### Breakpoint resolution (important)

Breakpoints are set by **source** file and line (e.g. `App.tsx` line 21). The service uses source maps to resolve this to the **bundle** position and then calls `Debugger.setBreakpointByUrl` with the bundle URL and generated line/column. If `locations` in the response is empty, the source map lookup failed (wrong path, file not in bundle, or source maps not loaded yet — wait for `debugger-connect` / script load to settle).

---

## Integrating with Agentic APIs (MCP, Skills)

### MCP (Model Context Protocol)

- The **tools server** exposes:
  - `GET http://localhost:3001/tools` — list tools (name, description, inputSchema).
  - `POST http://localhost:3001/tools/:name` — invoke a tool with JSON body.
- The **@radon-lite/mcp** package is a bridge: it fetches the tool list from the tools server and proxies **all** registered tools to the MCP server. So *every tool registered in the registry (including all `debugger-` tools) is already available to MCP** — no code changes in the MCP package are required.
- In Cursor/Claude, the MCP server typically exposes these as `mcp__radon-lite__<tool-id>`, e.g.:
  - `mcp__radon-lite__debugger-connect`
  - `mcp__radon-lite__debugger-set-breakpoint`
  - `mcp__radon-lite__debugger-inspect-element`
  - etc.
- **What you need to do**:
  1. Run the tools server (e.g. port 3001) and ensure MCP is configured to use `RADON_TOOLS_URL=http://localhost:3001` (or the same URL your client uses).
  2. In your **agent permissions / allow list**, add the debugger tools you want the agent to call, e.g.:
    - `mcp__radon-lite__debugger-connect`
    - `mcp__radon-lite__debugger-status`
    - `mcp__radon-lite__debugger-evaluate`
    - `mcp__radon-lite__debugger-set-breakpoint`
    - `mcp__radon-lite__debugger-remove-breakpoint`
    - `mcp__radon-lite__debugger-pause`
    - `mcp__radon-lite__debugger-resume`
    - `mcp__radon-lite__debugger-step`
    - `mcp__radon-lite__debugger-component-tree`
    - `mcp__radon-lite__debugger-inspect-element`
    - `mcp__radon-lite__debugger-console-logs`
    - `mcp__radon-lite__debugger-console-listen`
  3. License: debugger tools are **not** in the license-exempt list; a valid Radon Lite license (e.g. via `activate-sso` or `activate-license-key`) is required for MCP calls to these tools.

### Skills (e.g. Cursor / Claude skills)

- **Skills** are instructions or docs that tell an agent *when* and *how* to use tools (e.g. “use MCP tools only for simulator”, “call debugger-connect before setting breakpoints”).
- You can add a **Metro debugger skill** that:
  - Tells the agent to use `mcp__radon-lite__debugger-`* for Metro/React Native debugging.
  - Describes the workflow: connect → set breakpoints by file/line → run app → on pause use step/resume, inspect element, or evaluate.
  - Mentions that breakpoints use source file and line and that the agent should not fabricate bundle URLs.
- Place the skill file in your skills package (e.g. `packages/skills/skills/metro-debugger.md` — create it if needed) or in `.claude/skills/`, and reference it in your agent configuration so the model has access to it. Current skills in this repo include `simulator-setup.md`, `simulator-interact.md`, `simulator-screenshot.md`, `test-ui-flow.md`; a dedicated Metro debugger skill can be added the same way.

