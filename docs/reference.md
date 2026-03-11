# Argent — Dictionary

Reference for modules, concepts, and features in the codebase. Use this as a quick guide into how the repo is structured and how the tooling we provide works.

---

## Packages (workspace)

| Package                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **@argent/registry**    | Core library: dependency-aware service lifecycle and stateless tool invocation. Defines registry, blueprints, tools, URNs, and errors. No HTTP or simulator logic. Services defined through blueprints govern the long-running tasks and allow for tool interaction (such as: managing the running simulator server, connecting to existing metro session and plugging into debugger). |
| **@argent/tool-server** | Tools server allowing for tool usage and tool implementations. Depends on `@argent/registry`, sets up the registry, registers blueprints and tools, exposes HTTP API (`GET/POST /tools`, `/registry/snapshot`). The tools are defined to be atomic actions which can be called by the client using the server.                                                                     |
| **@argent/mcp**         | MCP (Model Context Protocol) bridge. Fetches the tool list from the tools server and proxies all tool calls to it. Exposes Argent tools to MCP clients (e.g. Cursor, Claude).                                                                                                                                                                                                      |
| **@argent/ui**          | Web UI for simulator control and Metro debugging. Calls the tools server over HTTP and maintains WebSocket sessions to simulator-server for touch/gestures.                                                                                                                                                                                                                            |
| **@argent/skills**      | Claude/Cursor skills (markdown instructions) for when and how to use Argent tools. Installable via `radon-skills`; places skill files in the user’s skills directory.                                                                                                                                                                                                              |
| **@argent/vscode**      | VS Code extension (minimal; contributes launch configs and tasks for Tools Server and UI).                                                                                                                                                                                                                                                                                             |

---

## Registry (tool / services registry)

(from `@argent/registry`)

The single central object that coordinates **tools** and **services**:

- **Blueprints** — Templates for context-aware services (e.g. `SimulatorServer`, `JsRuntimeDebugger`). Each blueprint has a namespace, `getURN(context)`, optional dependencies, and a `factory` that creates a service instance. The registry does **not** start any services at startup; it only stores these templates.
- **Services** — Long-running instances (e.g. a simulator-server process, a Metro CDP connection) created **on demand** and identified by **URN** (e.g. `SimulatorServer:<udid>`, `JsRuntimeDebugger:8081`). When something asks for a service by URN, the registry:
  - calls `resolveService(urn)`
  - if there is an instance for the URN, it reuses it, otherwise...
  - finds the blueprint for that URN
  - resolves any dependencies (recursively)
  - runs the blueprint’s `factory`
  - caches the instance
- **Tools** — Named operations with an input schema, `services(params)`, and `execute(resolvedServices, params)`. Tools are stateless; they receive resolved service APIs when they run.

**Invocation flow** — When you call `registry.invokeTool(id, params)`:

1. The registry looks up the tool and calls `tool.services(params)` to get a map of alias → URN (and optional resolve options).
2. For each URN it calls `resolveService(urn, options)` (creating the service via the blueprint’s factory if it doesn’t exist yet).
3. It then calls `tool.execute(resolvedServices, params)` with those APIs.
   So the **trigger** for starting a service is always “a tool that depends on it was invoked”; the registry never starts services by itself.

**Lifecycle** — The registry tracks service state (e.g. PENDING, RUNNING, ERROR), emits events (tool invoked/completed/failed, service state changes), and on `registry.dispose()` tears down running instances in dependency order.

The tool-server creates one Registry in `packages/tool-server/src/utils/setup-registry.ts`, registers all blueprints and tools there, and the HTTP app uses that single instance for all routes (see Tools server below).

---

## Tool server

The **tool server** is the Node/Express process in `@argent/tool-server` (default port 3001). It is the only place that **owns and configures** the registry in this repo.

- **Setup** — On startup (`packages/tool-server/src/index.ts`): it creates a registry via `createRegistry()`, attaches the registry logger, builds the HTTP app with `createHttpApp(registry)`, and starts listening.

`createRegistry()` (in `utils/setup-registry.ts`) instantiates a single `Registry`, registers the two blueprints (SimulatorServer, JsRuntimeDebugger) and all tools (simulator, interactions, debugger, license, documentation), then returns it. No services are started at this point.

**Interaction with the registry** — Every request that needs the registry uses that one instance:

- **GET /tools** — Reads `registry.getSnapshot().tools` and `registry.getTool(id)` to return tool list with descriptions and input schemas.
- **POST /tools/:name** — After license gating and body validation, calls `registry.invokeTool(name, parsedData, { signal })`. The registry then resolves any services required by that tool (starting them if needed) and runs the tool’s `execute`. The response is the tool’s return value or an error.
- **GET /registry/snapshot** — Returns `registry.getSnapshot()` (service states, namespaces, tool ids) for debugging or UI state.
  So the tools server is a thin HTTP layer: it does not implement tool logic or service factories; it only wires the registry to the network (and applies license checks and CORS).

**Shutdown** — On SIGINT/SIGTERM the server runs `registry.dispose()` then closes the HTTP server. Disposing the registry stops all running service instances (e.g. simulator-server processes, CDP connections) in dependency order.

---

## Simulator server

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
  Identifies a service instance, e.g. `SimulatorServer:ABC-123`, `JsRuntimeDebugger:8081`. Format: `namespace:payload` (payload may contain colons). Parsed by `parseURN` in `@argent/registry`.

---

## Tools

- **Tool** (`ToolDefinition`)  
  A single invocable operation: `id`, `description`, optional `zodSchema` / `inputSchema`, optional `outputHint`, `services(params)` (returns alias → URN or `{ urn, options }`), and `execute(services, params, options)`. The Registry resolves the URNs to APIs, then calls `execute`. Tools are registered with `registry.registerTool(...)` in `setup-registry.ts`.
- **Tool categories in this repo** (all registered in `packages/tool-server/src/utils/setup-registry.ts`)
  - **Simulator lifecycle:** `list-simulators`, `boot-simulator`, `simulator-server`, `launch-app`, `open-url`, `rotate`.
  - **Interactions:** `tap`, `swipe`, `gesture`, `button`, `keyboard`, `paste`, `screenshot`, `describe`.
  - **Debugger (Metro/CDP):** `debugger-connect`, `debugger-status`, `debugger-evaluate`, `debugger-set-breakpoint`, `debugger-remove-breakpoint`, `debugger-pause`, `debugger-resume`, `debugger-step`, `debugger-component-tree`, `debugger-inspect-element`, `debugger-console-logs`, `debugger-console-listen`.
  - **License:** `activate-license-key`, `activate-sso`, `get-license-status`, `remove-license`.
  - **Documentation:** `query-documentation`.

---

## License and activation

- **License**  
  Stored in macOS Keychain (service `argent`, account `license-token`). Used by the tools server HTTP layer to gate non–license tools (402 if missing). License tools (`activate-`\*, `get-license-status`, `remove-license`) are exempt.
- **activate-sso / activate-license-key**  
  Tools that obtain and store a JWT (SSO via browser or license key). Optional `token` in tool params can be passed through to the SimulatorServer blueprint for Pro features (e.g. screenshot/recording).

---

## Metro / debugger / js-debugger

- **JsRuntimeDebugger**  
  Blueprint that connects to a Metro dev server (default port 8081) via Chrome DevTools Protocol (CDP). One instance per port (URN like `JsRuntimeDebugger:8081`). Exposes CDP client, source maps, source resolver, console logs, and a small WebSocket server for console log streaming.
- **debugger-\*** tools  
  All Metro/CDP tools (connect, status, evaluate, breakpoints, pause/resume/step, component tree, inspect element, console logs/listen). They resolve `JsRuntimeDebugger:port` and use its API. See `docs/metro-debugger-features.md` for usage and MCP/skills integration.

---

## MCP

The `@argent/mcp` package runs an MCP server that lists tools from `RADON_TOOLS_URL` and forwards `CallTool` to `POST /tools/:name`. So “all tools registered in the Registry” are exposed to MCP (including debugger and simulator tools). Image-capable tools use `outputHint: "image"` so the bridge can return inline base64 images.

---

## Skills

Markdown files that instruct an agent when and how to use Argent tools (e.g. simulator setup, interaction, screenshots, Metro debugging). Lives under `packages/skills/skills/`. The `radon-skills` CLI installs them into the user’s skills directory (e.g. Cursor/Claude). They do not implement tools; they describe usage.

---

## UI

`packages/ui` uses `createClient(toolsUrl)` and `createSessionClient(apiUrl)`. The first talks to the tools server (list simulators, boot, start simulator session, Metro tools). The second talks to a single simulator-server’s WebSocket and HTTP (touch, scroll, button, paste, screenshot, token update). So: **client** = tools server API; **session client** = one simulator-server session.

---

## Quick comparison

| Term                 | What it is                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| **registry**         | Core object: blueprints + service instances (by URN) + tools; lifecycle and `invokeTool`.           |
| **tool-server**      | Node HTTP server (port 3001) that holds the Registry and exposes `/tools` and `/registry/snapshot`. |
| **simulator-server** | Native binary, one per simulator, exposing HTTP + WebSocket for device I/O.                         |
| **blueprint**        | Template for creating service instances (URN from context, factory, optional dependencies).         |
| **tool**             | Named operation with params, declared service URNs, and `execute`; registered on the Registry.      |
