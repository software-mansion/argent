# Radon Lite — Dictionary

A concise reference for modules, concepts, and features in the codebase. Use this to tell apart similarly named pieces (e.g. Registry vs simulator-registry) and understand how they fit together.

---

## Packages (workspace)


| Package                  | Purpose                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **@radon-lite/registry** | Core library: dependency-aware service lifecycle and stateless tool invocation. Defines `Registry`, blueprints, tools, URNs, and errors. No HTTP or simulator logic.                                                                   |
| **@radon-lite/tool-server**    | Tools server and tool implementations. Depends on `@radon-lite/registry`, registers blueprints and tools, exposes HTTP API (`GET/POST /tools`, `/registry/snapshot`). Runs the simulator-server binary and Metro debugger integration. |
| **@radon-lite/mcp**      | MCP (Model Context Protocol) bridge. Fetches the tool list from the tools server and proxies all tool calls to it. Exposes Radon Lite tools to MCP clients (e.g. Cursor, Claude).                                                      |
| **@radon-lite/ui**       | Web UI for simulator control and Metro debugging. Calls the tools server over HTTP and maintains WebSocket sessions to simulator-server for touch/gestures.                                                                            |
| **@radon-lite/skills**   | Claude/Cursor skills (markdown instructions) for when and how to use Radon Lite tools. Installable via `radon-skills`; places skill files in the user’s skills directory.                                                              |
| **@radon-lite/vscode**   | VS Code extension (minimal; contributes launch configs and tasks for Tools Server and UI).                                                                                                                                             |


---

## Registry vs “tool registry” vs simulator-registry

- **Registry** (from `@radon-lite/registry`)  
The single central object that:
  - Holds **blueprints** (templates for context-aware services).
  - Resolves **services** by URN (just-in-time instantiation, dependency order).
  - Holds **tools** (id, description, input schema, `services(params)` → URNs, `execute(services, params)`).
  - Emits events (service state, tool invoked/completed/failed).
  - On shutdown, disposes running service instances in dependency order.
  The tools package creates one `Registry` in `setup-registry.ts`, registers all blueprints and tools on it, and the HTTP app uses it for `GET /tools`, `POST /tools/:name`, and `GET /registry/snapshot`.
- **“Tool registry”**  
Colloquial: the fact that the tools server maintains a **list of tools** (and their schemas). That list lives inside the same `Registry` instance (the `tools` map). So “tool registry” = the tool-registration aspect of the core Registry, not a separate component.
- **simulator-registry** (`packages/tool-server/src/simulator-registry.ts`)  
A separate, **in-memory** map used to track **spawned simulator-server processes** and their WebSocket connections: `udid → { proc, udid, apiUrl, streamUrl }` and per-UDID WebSocket. It provides `setProcess`, `getProcess`, `ensureServer`, `sendCommand`, `httpScreenshot`, etc.  
**Difference from Registry:** The core Registry manages **service instances by URN** (e.g. `SimulatorServer:udid`) and uses **blueprints** to create them. The simulator-registry is a lower-level process/connection cache. In the current design, the **simulator-server blueprint** spawns the binary directly; simulator-registry is an alternative/legacy path for process tracking and is not wired in the main tool execution path (tools use `simulator-api` with the API returned by the blueprint).

---

## Tools server vs simulator-server

- **Tools server**  
The Node/Express process in `@radon-lite/tool-server` (default port 3001). It owns the Registry, exposes `GET /tools`, `POST /tools/:name`, `GET /registry/snapshot`, and runs license gating (except for license tools). Agents and the UI talk to this server to list and invoke tools.
- **simulator-server**  
The **native binary** (`simulator-server` at repo root) that runs **per simulator**. The tools server spawns it (via the SimulatorServer blueprint) with args like `ios --id <udid>`. It exposes:
  - HTTP: `apiUrl` (e.g. `/api/screenshot`, `/api/ui/describe`, `/api/token/verify`).
  - WebSocket: `ws://<host>/ws` for touch, wheel, button, paste, rotate.
  - stdout: `stream_ready <url>`, `api_ready <url>`; stdin: `token <jwt>`, `key Down|Up <keyCode>`.
  So: **tools server** = Node API that orchestrates tools; **simulator-server** = one process per booted simulator, doing the actual device I/O.

---

## Blueprints and services

- **Blueprint** (`ServiceBlueprint`)  
A template for creating **context-aware** service instances. It has:
  - `namespace` (e.g. `SimulatorServer`, `JsRuntimeDebugger`).
  - `getURN(context)` → URN string (e.g. `SimulatorServer:udid`).
  - Optional `getDependencies(context)` → alias → URN.
  - `factory(deps, context, options)` → creates the service instance (e.g. spawns simulator-server, or connects to Metro CDP).
- **Service / service instance**  
Created by a blueprint’s factory. Has `api` (object given to tools), `dispose()`, and `events` (e.g. `terminated`). The Registry resolves a URN to a service instance (creating it on first use) and passes `api` into tools as resolved “services”.
- **URN**  
Identifies a service instance, e.g. `SimulatorServer:ABC-123`, `JsRuntimeDebugger:8081`. Format: `namespace:payload` (payload may contain colons). Parsed by `parseURN` in `@radon-lite/registry`.

---

## Tools

- **Tool** (`ToolDefinition`)  
A single invocable operation: `id`, `description`, optional `zodSchema` / `inputSchema`, optional `outputHint`, `services(params)` (returns alias → URN or `{ urn, options }`), and `execute(services, params, options)`. The Registry resolves the URNs to APIs, then calls `execute`. Tools are registered with `registry.registerTool(...)` in `setup-registry.ts`.
- **Tool categories in this repo**  
  - **Simulator lifecycle:** `list-simulators`, `boot-simulator`, `simulator-server`, `launch-app`, `open-url`, `rotate`.  
  - **Interactions:** `tap`, `swipe`, `gesture`, `button`, `keyboard`, `paste`, `screenshot`, `describe`.  
  - **Debugger (Metro/CDP):** `debugger-connect`, `debugger-status`, `debugger-evaluate`, `debugger-set-breakpoint`, `debugger-remove-breakpoint`, `debugger-pause`, `debugger-resume`, `debugger-step`, `debugger-component-tree`, `debugger-inspect-element`, `debugger-console-logs`, `debugger-console-listen`.  
  - **License:** `activate-license-key`, `activate-sso`, `get-license-status`, `remove-license`.

---

## simulator-api

- **simulator-api** (`packages/tool-server/src/simulator-api.ts`)  
Helpers that talk to a **running** simulator-server instance (given its `SimulatorServerApi`): `sendCommand(api, cmd)` (WebSocket), `httpDescribe(api)`, `httpScreenshot(api, ...)`. Used by interaction and simulator tools that already have the API from the Registry (e.g. after resolving `SimulatorServer:udid`). So: Registry + blueprint provide the `SimulatorServerApi`; simulator-api uses it to send commands and HTTP requests.

---

## License and activation

- **License**  
Stored in macOS Keychain (service `radon-lite`, account `license-token`). Used by the tools server HTTP layer to gate non–license tools (402 if missing). License tools (`activate-`*, `get-license-status`, `remove-license`) are exempt.
- **activation-tui**  
Terminal UI (e.g. when a tool is called without a valid token): prompts for SSO or license key, runs the corresponding activate tool, and can return the token for the current request.
- **activate-sso / activate-license-key**  
Tools that obtain and store a JWT (SSO via browser or license key). Optional `token` in tool params can be passed through to the SimulatorServer blueprint for Pro features (e.g. screenshot/recording).

---

## Metro / debugger

- **JsRuntimeDebugger**  
Blueprint that connects to a Metro dev server (default port 8081) via Chrome DevTools Protocol (CDP). One instance per port (URN like `JsRuntimeDebugger:8081`). Exposes CDP client, source maps, source resolver, console logs, and a small WebSocket server for console log streaming.
- **debugger-*** tools  
All Metro/CDP tools (connect, status, evaluate, breakpoints, pause/resume/step, component tree, inspect element, console logs/listen). They resolve `JsRuntimeDebugger:port` and use its API. See `docs/metro-debugger-features.md` for usage and MCP/skills integration.

---

## MCP and UI

- **MCP**  
The `@radon-lite/mcp` package runs an MCP server that lists tools from `RADON_TOOLS_URL` and forwards `CallTool` to `POST /tools/:name`. So “all tools registered in the Registry” are exposed to MCP (including debugger and simulator tools). Image-capable tools use `outputHint: "image"` so the bridge can return inline base64 images.
- **UI client**  
`packages/ui` uses `createClient(toolsUrl)` and `createSessionClient(apiUrl)`. The first talks to the tools server (list simulators, boot, start simulator session, Metro tools). The second talks to a single simulator-server’s WebSocket and HTTP (touch, scroll, button, paste, screenshot, token update). So: **client** = tools server API; **session client** = one simulator-server session.

---

## Skills

- **Skills**  
Markdown files that instruct an agent when and how to use Radon Lite tools (e.g. simulator setup, interaction, screenshots, Metro debugging). Lives under `packages/skills/skills/`. The `radon-skills` CLI installs them into the user’s skills directory (e.g. Cursor/Claude). They do not implement tools; they describe usage.

---

## Quick comparison


| Term                   | What it is                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **Registry**           | Core object: blueprints + service instances (by URN) + tools; lifecycle and `invokeTool`.           |
| **simulator-registry** | In-memory map of simulator-server processes and WebSockets (udid → process/connection).             |
| **Tools server**       | Node HTTP server (port 3001) that holds the Registry and exposes `/tools` and `/registry/snapshot`. |
| **simulator-server**   | Native binary, one per simulator, exposing HTTP + WebSocket for device I/O.                         |
| **simulator-api**      | Module that sends commands and HTTP requests to a `SimulatorServerApi` (from Registry).             |
| **Blueprint**          | Template for creating service instances (URN from context, factory, optional dependencies).         |
| **Tool**               | Named operation with params, declared service URNs, and `execute`; registered on the Registry.      |


