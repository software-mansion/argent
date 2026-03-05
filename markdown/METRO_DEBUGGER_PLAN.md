# Metro Debugger Service — Implementation Plan

## 1. Executive Summary

This document specifies the architecture and step-by-step implementation of a **MetroDebugger service** for radon-lite that hooks into an already-running Metro dev server's CDP (Chrome DevTools Protocol) endpoint. The service enables debugger control (breakpoints, stepping, pause/resume), element inspection (tap-to-inspect with source-mapped code locations), and component tree introspection — all without modifying the React Native app or starting Metro ourselves.

The design follows the existing radon-lite patterns exactly: a **ServiceBlueprint** registered in the registry, tools that declare a dependency on the service via URN, and an HTTP API exposed through the tools server.

---

## 2. Prior Art & Validated Approach

The `~/Desktop/metro_test` folder contains a working prototype (`web_inspector/server.js`) and two research documents that prove the following:

| Capability | Mechanism | Verified? |
|---|---|---|
| Discover running Metro | `GET /status` + `GET /json/list` on ports 8081/8082 | Yes |
| CDP WebSocket connection | Connect to `webSocketDebuggerUrl` from `/json/list` | Yes |
| JS evaluation in app | `Runtime.evaluate` over CDP | Yes |
| Breakpoints | `Debugger.setBreakpointByUrl` / `Debugger.setBreakpoint` | Needs verification |
| Step / pause / resume | `Debugger.pause`, `Debugger.resume`, `Debugger.stepOver/Into/Out` | Needs verification |
| Component tree | Walk `__REACT_DEVTOOLS_GLOBAL_HOOK__` fiber tree via `Runtime.evaluate` | Yes |
| Tap-to-inspect at (x,y) | `rendererConfig.getInspectorDataForViewAtPoint` via `Runtime.evaluate` | Yes |
| Source resolution | `fiber._debugStack` frame → `POST /symbolicate` → original file:line | Yes |
| Push from app → server | `Runtime.addBinding` + `Runtime.bindingCalled` events | Yes |
| Render highlighting | Dynamic `onCommitFiberRoot` patch via `Runtime.evaluate` | Yes |

**Key constraint**: Metro allows only one CDP debugger connection per page. Connecting a second client disconnects the first.

---

## 3. Architecture

### 3.1 Service Dependency Graph

```
MetroDebugger:{port}          ← ServiceBlueprint (namespace: "MetroDebugger")
   │
   ├── discover Metro at port
   ├── select CDP target
   ├── open WebSocket to webSocketDebuggerUrl
   ├── CDP domain setup:
   │     FuseboxClient.setClientMetadata (ignore errors)
   │     ReactNativeApplication.enable   (ignore errors)
   │     Runtime.enable
   │     Debugger.enable (+ scriptParsed accumulation)
   │     Debugger.setPauseOnExceptions({ state: "none" })
   │     Debugger.setAsyncCallStackDepth({ maxDepth: 32 })
   │     Runtime.runIfWaitingForDebugger  (ignore errors)
   │     Runtime.addBinding("__radon_lite_callback")
   └── expose MetroDebuggerApi
         │
         ├── Tools (no service deps of their own, they depend on MetroDebugger:{port})
         │   ├── metro-connect           ← start the service, return connection info
         │   ├── metro-evaluate          ← raw JS evaluation
         │   ├── metro-set-breakpoint    ← Debugger.setBreakpointByUrl
         │   ├── metro-remove-breakpoint ← Debugger.removeBreakpoint
         │   ├── metro-pause             ← Debugger.pause
         │   ├── metro-resume            ← Debugger.resume
         │   ├── metro-step              ← stepOver / stepInto / stepOut
         │   ├── metro-inspect-element   ← tap-to-inspect at (x,y) with source
         │   ├── metro-component-tree    ← full fiber tree with bounding rects
         │   └── metro-status             ← connection state, target info
         │
         └── Can also depend on SimulatorServer:{udid} for tools that combine both
```

### 3.2 Package Layout

All code lives in `packages/tools` (the existing tools package), following the established pattern. No new package is needed.

```
packages/tools/src/
├── blueprints/
│   ├── simulator-server.ts          ← existing
│   └── metro-debugger.ts            ← NEW: MetroDebugger blueprint
├── metro/
│   ├── discovery.ts                 ← NEW: Metro HTTP discovery (GET /status, /json/list)
│   ├── cdp-client.ts               ← NEW: CDP WebSocket client wrapper
│   ├── target-selection.ts          ← NEW: pick the right CDP target from /json/list
│   ├── source-resolver.ts          ← NEW: _debugStack parsing + POST /symbolicate
│   └── scripts/
│       ├── component-tree.ts        ← NEW: JS script injected via Runtime.evaluate
│       ├── inspect-at-point.ts      ← NEW: JS script for getInspectorDataForViewAtPoint
│       └── render-hook.ts           ← NEW: JS script for onCommitFiberRoot patching
├── tools/
│   ├── ... (existing tools)
│   ├── metro-connect.ts             ← NEW
│   ├── metro-evaluate.ts            ← NEW
│   ├── metro-set-breakpoint.ts      ← NEW
│   ├── metro-remove-breakpoint.ts   ← NEW
│   ├── metro-pause.ts               ← NEW
│   ├── metro-resume.ts              ← NEW
│   ├── metro-step.ts                ← NEW
│   ├── metro-inspect-element.ts     ← NEW
│   ├── metro-component-tree.ts      ← NEW
│   └── metro-status.ts              ← NEW
└── setup-registry.ts               ← MODIFIED: register new blueprint + tools
```

### 3.3 URN Scheme

```
MetroDebugger:8081          ← instance scoped to Metro port
MetroDebugger:8082
```

The port is the natural scope key — each Metro server runs on a distinct port, and only one CDP connection is allowed per target page. Using port as the URN payload matches how `SimulatorServer` uses UDID.

---

## 4. Detailed Component Design

### 4.1 Metro Discovery (`metro/discovery.ts`)

Responsible for confirming a Metro server is running and fetching the list of CDP targets.

```typescript
export interface MetroInfo {
  port: number;
  projectRoot: string;
  targets: CDPTarget[];
}

export interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      nativePageReloads?: boolean;
      prefersFuseboxFrontend?: boolean;
    };
  };
}

export async function discoverMetro(port: number): Promise<MetroInfo>
```

Implementation:
1. `GET http://localhost:{port}/status` — check response body is `packager-status:running`
2. Extract `X-React-Native-Project-Root` header → `projectRoot`
3. `GET http://localhost:{port}/json/list` → parse as `CDPTarget[]`
4. Throw if no targets found

### 4.2 Target Selection (`metro/target-selection.ts`)

Picks the correct CDP target from the list, handling RN >= 0.76 (Fusebox), older versions, Expo Go, and multi-device scenarios.

```typescript
export interface SelectedTarget {
  target: CDPTarget;
  webSocketUrl: string;     // normalized (localhost, correct port)
  isNewDebugger: boolean;   // Fusebox vs legacy
  deviceName: string;
}

export function selectTarget(
  targets: CDPTarget[],
  port: number,
  options?: Record<string, unknown>
): SelectedTarget
```

Selection priority (matching Radon's `DebuggerTarget.ts`):
1. `reactNative.capabilities.prefersFuseboxFrontend === true`
2. `description` ends with `[C++ connection]`
3. `title` starts with `React Native Bridge`
4. Fallback: first target

**Multi-device disambiguation**: When `options?.deviceId` or `options?.deviceName` is provided, filter targets by `reactNative.logicalDeviceId` or `deviceName` before applying the selection priority. Without these options, the first matching target is used (most recently registered device).

**Expo Go filtering**: Expo Go apps report two CDP targets — the host runtime and the app runtime. The host runtime sets `globalThis.__expo_hide_from_inspector__ = true`. When multiple new-debugger targets are found, iterate them in reverse and make a temporary CDP connection to each to evaluate `globalThis.__expo_hide_from_inspector__`. Select the first target where this evaluates to falsy (the app runtime). This matches Radon's `isActiveExpoGoAppRuntime` pattern. For v1, Expo Go support may be deferred — if so, document that only the bare RN app path is tested, and Expo Go may select the wrong target.

**URL normalization** (covers both iOS and Android):
- Rewrite `webSocketDebuggerUrl` host to `localhost` and port to the Metro port. This is critical because:
  - Metro proxy may return internal addresses
  - Android emulators use virtual network IPs (e.g. `10.0.2.2`) that are not reachable from the host
  - iOS simulators may use `127.0.0.1` instead of `localhost`
- Implementation: `const url = new URL(wsUrl); url.hostname = "localhost"; url.port = port.toString(); return url.toString();`
- This matches Radon's `fixupWebSocketDebuggerUrl` in `metro.ts`.

### 4.3 CDP Client (`metro/cdp-client.ts`)

A typed WebSocket wrapper that speaks CDP. This is the core communication layer.

```typescript
export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  endLine: number;
}

export interface CDPClientEvents {
  connected: () => void;
  disconnected: (error?: Error) => void;
  event: (method: string, params: Record<string, unknown>) => void;
  bindingCalled: (name: string, payload: string) => void;
  scriptParsed: (script: ScriptInfo) => void;
  paused: (params: Record<string, unknown>) => void;
}

export class CDPClient {
  readonly events: TypedEventEmitter<CDPClientEvents>;

  constructor(wsUrl: string);

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /** Send a CDP command and wait for its response. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;

  /** Shorthand: Runtime.evaluate with expression, return parsed result. */
  evaluate(expression: string, options?: { timeout?: number }): Promise<unknown>;

  /** Register a named binding; incoming calls arrive via 'bindingCalled' event. */
  addBinding(name: string): Promise<void>;

  /** Returns all scripts reported by Debugger.scriptParsed events. */
  getLoadedScripts(): Map<string, ScriptInfo>;

  /** Returns the set of CDP domains currently enabled (e.g. "Runtime", "Debugger"). */
  getEnabledDomains(): ReadonlySet<string>;

  /**
   * Request-ID based binding dispatch: send a script that will call the binding
   * with a payload containing { requestId, ... }, and wait for the matching response.
   * Returns the parsed payload. Rejects on timeout.
   */
  evaluateWithBinding(
    expression: string,
    requestId: string,
    options?: { timeout?: number }
  ): Promise<Record<string, unknown>>;
}
```

Internal details:
- **Auto-incrementing message IDs** for CDP request/response correlation
- **Pending request map** with configurable timeout (default 10s)
- **Domain tracking**: a `Set<string>` of enabled domains, updated on successful `*.enable` / `*.disable` responses. The `send()` method detects `method.endsWith(".enable")` / `method.endsWith(".disable")` patterns and updates the set after a successful response.
- **Script accumulation**: a `Map<scriptId, ScriptInfo>` populated by `Debugger.scriptParsed` events. Exposed via `getLoadedScripts()`. Cleared on disconnect.
- **Binding dispatch with request IDs**: `evaluateWithBinding(expression, requestId)` injects a script and sets up a one-shot listener that matches the `requestId` field in the `Runtime.bindingCalled` payload. This eliminates the race condition from the prototype's `pendingInspect` pattern — concurrent calls each have unique IDs and only resolve their own response.
- **`Runtime.bindingCalled` routing**: incoming binding events are checked against the pending `evaluateWithBinding` requests first (by `requestId`). Unmatched events are emitted on the generic `bindingCalled` event (used by render hook push events).
- **`Debugger.paused` forwarding**: `Debugger.paused` events are emitted on the dedicated `paused` event for tools that need to react to breakpoint hits.
- **Reconnect is NOT built-in** — the blueprint handles lifecycle (reconnect = teardown + re-resolve)

### 4.4 Source Resolver (`metro/source-resolver.ts`)

Maps bundle line:col to original TypeScript/JavaScript source using Metro's `/symbolicate` endpoint and `fiber._debugStack`.

```typescript
export interface SourceLocation {
  file: string;       // relative path from project root (e.g. "App.tsx")
  line: number;
  column: number;
}

export interface SourceResolver {
  /** Resolve a raw _debugStack string to the original source location.
   *  Returns null if symbolication fails or points to node_modules. */
  resolveDebugStack(debugStack: string): Promise<SourceLocation | null>;

  /** Resolve a bundle URL + line:col directly. */
  symbolicate(bundleUrl: string, line: number, col: number): Promise<SourceLocation | null>;

  /** Read the source code fragment around the resolved location. */
  readSourceFragment(location: SourceLocation, contextLines?: number): Promise<string | null>;
}

export function createSourceResolver(port: number, projectRoot: string): SourceResolver
```

`_debugStack` parsing logic (from the prototype):
1. Split stack by `\n`, filter lines starting with `at `
2. Frame `[1]` is the JSX call-site in the parent component (frame `[0]` is the React internal)
3. Parse `at FnName (bundleUrl:line:col)` with regex
4. Normalize bundle URL:
   - iOS: `//&` → `?` (iOS reports `index.bundle//&platform=ios...`)
   - Android: rewrite hostname to `localhost` and port to the Metro port (Android emulator uses `10.0.2.2` or device IP)
   - General: strip any non-standard URL artifacts
   This matches the combined behavior of Radon's `normalizeBundleUrl` + `compareIgnoringHost` patterns.
5. `POST http://localhost:{port}/symbolicate` with the frame
6. Return the symbolicated file:line, stripping `projectRoot` prefix

`readSourceFragment` implementation:
1. Use the resolved absolute file path (`projectRoot + '/' + file`)
2. Read the file from disk with `fs.readFile`
3. Extract lines `[line - contextLines, line + contextLines]`
4. Return the fragment as a string

### 4.5 MetroDebugger Blueprint (`blueprints/metro-debugger.ts`)

```typescript
export const METRO_DEBUGGER_NAMESPACE = "MetroDebugger";

export interface MetroDebuggerApi {
  port: number;
  projectRoot: string;
  deviceName: string;
  isNewDebugger: boolean;
  cdp: CDPClient;
  sourceResolver: SourceResolver;
}

export const metroDebuggerBlueprint: ServiceBlueprint<MetroDebuggerApi, string> = {
  namespace: METRO_DEBUGGER_NAMESPACE,

  getURN(port: string) {
    return `${METRO_DEBUGGER_NAMESPACE}:${port}`;
  },

  async factory(_deps, payload, options?) {
    const port = parseInt(payload, 10);

    // 1. Discover Metro
    const metro = await discoverMetro(port);

    // 2. Select target (options may carry deviceId for multi-device disambiguation)
    const selected = selectTarget(metro.targets, port, options);

    // 3. Connect CDP
    const cdp = new CDPClient(selected.webSocketUrl);
    await cdp.connect();

    // 4. CDP domain setup (matching Radon's CDPSession.setUpDebugger sequence)
    //    Non-critical calls use .catch(ignore) — they may fail on older RN or
    //    non-Fusebox targets but must not block the connection.
    const ignore = () => {};
    await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
    await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
    await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 }).catch(ignore);
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
    await cdp.addBinding("__radon_lite_callback");

    // 5. Create source resolver
    const sourceResolver = createSourceResolver(port, metro.projectRoot);

    // 6. Build API
    const api: MetroDebuggerApi = {
      port,
      projectRoot: metro.projectRoot,
      deviceName: selected.deviceName,
      isNewDebugger: selected.isNewDebugger,
      cdp,
      sourceResolver,
    };

    // 7. Build ServiceInstance
    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api,
      dispose: async () => { await cdp.disconnect(); },
      events,
    };
  },
};
```

**Factory setup rationale**: `Debugger.enable` is called eagerly (not lazily in the first breakpoint tool) because it triggers `Debugger.scriptParsed` events for every loaded module. The `CDPClient` accumulates these events (see section 4.3) so they are available for the scriptId-based breakpoint fallback. `Debugger.setPauseOnExceptions({ state: "none" })` prevents the debugger from breaking on every caught exception. `Runtime.runIfWaitingForDebugger` unblocks apps that pause on startup waiting for a debugger attach (common in Expo dev builds).

**Lifecycle**: When the CDP WebSocket closes (Metro restart, app killed, etc.), the service emits `terminated`. The registry transitions it to `IDLE`/`ERROR`. Next tool invocation will re-resolve, triggering a fresh discovery + connection cycle. This matches how `SimulatorServer` handles process exit.

### 4.6 Injected Scripts (`metro/scripts/`)

These are JavaScript strings evaluated in the React Native runtime via `Runtime.evaluate`. They are stored as TypeScript template literals for maintainability.

#### `component-tree.ts`

Walks the React fiber tree via `__REACT_DEVTOOLS_GLOBAL_HOOK__`, collects component names, depths, and native bounding rectangles via `UIManager.measureInWindow`. Returns JSON array.

Based directly on the verified `COMPONENT_TREE_SCRIPT` from the prototype.

#### `inspect-at-point.ts`

Given `(x, y)` logical coordinates and a `requestId`, calls `rendererConfig.getInspectorDataForViewAtPoint` and collects `_debugStack` frame[1] for each component in the hierarchy. Pushes result via `__radon_lite_callback` binding with the `requestId` included in the payload, enabling concurrent inspect calls without race conditions.

Based on the verified `makeInspectScript` from the prototype, extended with request-ID correlation.

#### `render-hook.ts`

Patches `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` to detect re-renders. Tracks fibers with a `WeakMap`, distinguishes mounts from re-renders, measures bounding rects, and pushes results via the binding.

Based directly on the verified `RENDER_HOOK_SCRIPT` from the prototype.

---

## 5. Tool Definitions

All tools follow the existing `ToolDefinition<TParams, TResult>` pattern with `services()` returning `{ metroDebugger: "MetroDebugger:{port}" }`.

### 5.1 `metro-connect`

**Purpose**: Ensure the MetroDebugger service is running. Returns connection info.

```typescript
zodSchema: z.object({
  port: z.number().default(8081).describe("Metro server port"),
})

services: (params) => ({
  metroDebugger: `MetroDebugger:${params.port}`,
})

execute: returns { port, projectRoot, deviceName, isNewDebugger, connected: true }
```

### 5.2 `metro-status`

**Purpose**: Return connection info for the MetroDebugger service. If the service is not yet running, this tool will initiate the connection (same as `metro-connect`). The two tools differ only in description — `metro-connect` is phrased as an action ("connect to Metro"), while `metro-status` is phrased as a query ("get Metro connection info"). Both resolve the same `MetroDebugger:{port}` service, which is idempotent (returns the cached instance if already running).

> **Design note**: Tools in radon-lite cannot read registry state directly — they only receive resolved service APIs. A "check without connecting" tool would require registry API changes. Since `resolveService` is idempotent (returns the existing instance if `RUNNING`), resolving the service is the correct pattern. Non-existent Metro at the given port will fail with `ServiceInitializationError`, which the HTTP layer returns as a 500.

```typescript
zodSchema: z.object({
  port: z.number().default(8081).describe("Metro server port"),
})

services: (params) => ({
  metroDebugger: `MetroDebugger:${params.port}`,
})

execute: returns {
  port, projectRoot, deviceName, isNewDebugger,
  connected: cdp.isConnected(),
  loadedScripts: cdp.getLoadedScripts().size,
  enabledDomains: [...cdp.getEnabledDomains()],
}
```

### 5.3 `metro-evaluate`

**Purpose**: Execute arbitrary JavaScript in the app's JS runtime.

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
  expression: z.string().describe("JavaScript expression to evaluate"),
})

services: (params) => ({
  metroDebugger: `MetroDebugger:${params.port}`,
})

execute: calls cdp.evaluate(expression), returns result.value
```

### 5.4 `metro-set-breakpoint`

**Purpose**: Set a breakpoint at a file:line in the app's source code.

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
  file: z.string().describe("Source file path relative to project root"),
  line: z.number().describe("Line number (1-based)"),
  column: z.number().optional().describe("Column number (0-based)"),
  condition: z.string().optional().describe("Conditional breakpoint expression"),
})

services: (params) => ({
  metroDebugger: `MetroDebugger:${params.port}`,
})

execute:
  1. cdp.send("Debugger.setBreakpointByUrl", {
       lineNumber: line - 1,     // CDP is 0-based
       urlRegex: `.*${escapeRegex(file)}$`,
       columnNumber: column,
       condition,
     })
  2. Return { breakpointId, locations[] }
```

`Debugger.enable` is already called eagerly during the blueprint factory setup (section 4.5), so breakpoint tools do not need to enable it again.

**Important**: `Debugger.setBreakpointByUrl` uses a URL regex that matches the file's path within the Metro bundle. Metro's source maps map bundle locations back to original files, and the `urlRegex` approach is what Chrome DevTools uses internally. If verification (section 6) shows that Hermes uses bundle-line coordinates rather than source-mapped lines, the tool will need to reverse-map via the source map (using `cdp.getLoadedScripts()` to find the scriptId + sourceMapURL, then the `source-map` npm package).

### 5.5 `metro-remove-breakpoint`

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
  breakpointId: z.string().describe("Breakpoint ID returned by metro-set-breakpoint"),
})

execute: cdp.send("Debugger.removeBreakpoint", { breakpointId })
```

### 5.6 `metro-pause`

```typescript
zodSchema: z.object({ port: z.number().default(8081) })

execute: cdp.send("Debugger.pause")
```

### 5.7 `metro-resume`

```typescript
zodSchema: z.object({ port: z.number().default(8081) })

execute: cdp.send("Debugger.resume")
```

### 5.8 `metro-step`

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
  action: z.enum(["stepOver", "stepInto", "stepOut"]),
})

execute: cdp.send(`Debugger.${action}`)
```

### 5.9 `metro-component-tree`

**Purpose**: Return the full React component tree with names, depth, and bounding rectangles.

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
})

execute:
  1. cdp.evaluate(COMPONENT_TREE_SCRIPT)
  2. Parse JSON result
  3. Return array of { id, name, depth, rect: { x, y, w, h } | null, isHost, parentIdx }
```

### 5.10 `metro-inspect-element`

**Purpose**: Given logical screen coordinates (x, y), return the component hierarchy at that point with resolved source locations and code fragments.

```typescript
zodSchema: z.object({
  port: z.number().default(8081),
  x: z.number().describe("Logical X coordinate on device screen"),
  y: z.number().describe("Logical Y coordinate on device screen"),
  contextLines: z.number().default(3).describe("Lines of source context to include"),
})

execute:
  1. Generate a unique requestId (e.g. crypto.randomUUID())
  2. cdp.evaluateWithBinding(makeInspectScript(x, y, requestId), requestId)
     — the script calls __radon_lite_callback with { requestId, type: "inspect_result", ... }
     — evaluateWithBinding matches the response by requestId, eliminating race conditions
  3. For each item in result.items:
     a. sourceResolver.resolveDebugStack(item.frame) → SourceLocation
     b. sourceResolver.readSourceFragment(location, contextLines) → code string
  4. Return { x, y, items: [{ name, source: { file, line, column }, code }] }
```

---

## 6. CDP Debugger Domain — Verification Plan

Breakpoint and stepping commands need live verification against a Metro session. The following should be tested before implementation is finalized.

### 6.1 Test: `Debugger.enable` and `Debugger.setBreakpointByUrl`

```javascript
// Step 1: Enable the debugger domain
ws.send(JSON.stringify({ id: 1, method: "Debugger.enable", params: {} }));
// Expect: { id: 1, result: { debuggerId: "..." } }
// Expect: Multiple Debugger.scriptParsed events (one per loaded module)

// Step 2: Set a breakpoint by URL regex
ws.send(JSON.stringify({
  id: 2,
  method: "Debugger.setBreakpointByUrl",
  params: {
    lineNumber: 20,  // 0-based
    urlRegex: ".*App\\.tsx$",
  }
}));
// Expect: { id: 2, result: { breakpointId: "...", locations: [...] } }
```

**What to verify**:
- Does `Debugger.enable` work alongside `Runtime.enable` in Hermes (Fusebox)?
- Does `Debugger.setBreakpointByUrl` with a regex match the correct script?
- Does hitting the breakpoint fire `Debugger.paused` event?
- Does the app freeze when paused? (Expected: yes, JS thread halts)
- Does `Debugger.resume` unfreeze?

### 6.2 Test: `Debugger.setBreakpoint` (by scriptId)

Alternative approach — set breakpoint by exact script ID (obtained from `Debugger.scriptParsed` events):

```javascript
// After Debugger.enable, listen for scriptParsed events.
// Find the script whose URL matches your file.
// Then:
ws.send(JSON.stringify({
  id: 3,
  method: "Debugger.setBreakpoint",
  params: {
    location: { scriptId: "42", lineNumber: 20, columnNumber: 0 }
  }
}));
```

**What to verify**:
- Are `Debugger.scriptParsed` URLs the raw bundle module URLs or source-mapped?
- Can we map from source file path to scriptId reliably?

### 6.3 Test: Step operations while paused

```javascript
// After Debugger.paused fires:
ws.send(JSON.stringify({ id: 4, method: "Debugger.stepOver", params: {} }));
// Expect: Debugger.resumed → Debugger.paused at next line

ws.send(JSON.stringify({ id: 5, method: "Debugger.stepInto", params: {} }));
ws.send(JSON.stringify({ id: 6, method: "Debugger.stepOut", params: {} }));
```

### 6.4 Test: Interaction with existing debugger connections

Since Metro allows only one CDP client per page:
- Verify that our connection gracefully handles being disconnected by another client (e.g., Chrome DevTools)
- Verify that connecting while Chrome DevTools is already connected results in the expected behavior

### 6.5 Test Script

A standalone test script should be created at `packages/tools/test/metro-cdp-verify.ts` to run these tests against a live Metro session:

```typescript
// Usage: npx ts-node test/metro-cdp-verify.ts [port]
// Requires: a running Metro server with a connected React Native app
// Runs through the verification steps above and reports results
```

---

## 7. Source Map Resolution — Deep Dive

### 7.1 `_debugStack` vs `_debugSource`

| Property | Available | Mechanism |
|---|---|---|
| `fiber._debugSource` | Requires `@babel/plugin-transform-react-jsx-source` (NOT default in RN Metro) | Babel transform at compile time |
| `fiber._debugStack` | Always available in `__DEV__` bundles (React 18+) | `Error` stack trace captured at fiber creation |

We use `_debugStack` exclusively. The stack trace contains bundle URLs and line:col numbers that map through Metro's `/symbolicate` endpoint to original source files.

### 7.2 Stack Frame Parsing

The `_debugStack` property is an `Error` object. Its `.stack` string has the format:

```
Error: react-stack-top-frame
    at anonymous  (http://localhost:8081/index.bundle?platform=ios&dev=true:LINE0:COL0)
    at ParentComponent (http://localhost:8081/index.bundle?platform=ios&dev=true:LINE1:COL1)
    at react_stack_bottom_frame (...)
```

Frame `[1]` (second `at` line) is the call-site in the parent component's JSX where the child component is instantiated. This is the most useful location for "where is this component used."

### 7.3 iOS URL Normalization

On iOS devices, bundle URLs are reported as:
```
http://host/index.bundle//&platform=ios&dev=true&...
```
The `//&` must be normalized to `?` before passing to `/symbolicate`.

### 7.4 Source Fragment Extraction

After symbolication returns the original file path and line number, we read the file from disk (it's on the same machine as Metro) and extract the surrounding lines. This provides the actual code fragment to the caller — critical for an AI agent to understand component structure without additional file reads.

---

## 8. Step-by-Step Implementation Plan

### Phase 1: Core Infrastructure

| Step | File | Description |
|---|---|---|
| 1.0 | `packages/tools/package.json` | Add `vitest` to `devDependencies` (registry package already has it; tools package does not) |
| 1.1 | `metro/discovery.ts` | Metro HTTP discovery: `discoverMetro(port)` |
| 1.2 | `metro/target-selection.ts` | CDP target selection: `selectTarget(targets, port, options?)` with Android/Expo Go/multi-device handling |
| 1.3 | `metro/cdp-client.ts` | `CDPClient` class with typed events, `send()`, `evaluate()`, `addBinding()`, `evaluateWithBinding()`, `getLoadedScripts()`, `getEnabledDomains()` |
| 1.4 | `metro/source-resolver.ts` | `createSourceResolver()` with `resolveDebugStack()`, `symbolicate()`, `readSourceFragment()` and cross-platform URL normalization |
| 1.5 | Unit tests for discovery, target selection, source resolver (mocked HTTP/WS) |

### Phase 2: Blueprint & Basic Tools

| Step | File | Description |
|---|---|---|
| 2.1 | `blueprints/metro-debugger.ts` | `metroDebuggerBlueprint` with full lifecycle |
| 2.2 | `tools/metro-connect.ts` | Connect tool — starts the service |
| 2.3 | `tools/metro-status.ts` | Status tool — resolves MetroDebugger service, returns connection info |
| 2.4 | `tools/metro-evaluate.ts` | Raw JS evaluation tool |
| 2.5 | `setup-registry.ts` | Register the new blueprint and tools |
| 2.6 | Integration test with a mock CDP server |

### Phase 3: Breakpoints & Debugger Control

| Step | File | Description |
|---|---|---|
| 3.1 | Run `metro-cdp-verify.ts` against a live session to validate CDP Debugger domain |
| 3.2 | `tools/metro-set-breakpoint.ts` | Set breakpoint by file:line |
| 3.3 | `tools/metro-remove-breakpoint.ts` | Remove breakpoint by ID |
| 3.4 | `tools/metro-pause.ts` | Pause execution |
| 3.5 | `tools/metro-resume.ts` | Resume execution |
| 3.6 | `tools/metro-step.ts` | stepOver / stepInto / stepOut |
| 3.7 | Integration tests for breakpoint lifecycle |

### Phase 4: Element Inspector & Component Tree

| Step | File | Description |
|---|---|---|
| 4.1 | `metro/scripts/component-tree.ts` | Fiber tree walk script |
| 4.2 | `metro/scripts/inspect-at-point.ts` | Tap-to-inspect script |
| 4.3 | `metro/scripts/render-hook.ts` | Render highlighting script |
| 4.4 | `tools/metro-component-tree.ts` | Component tree tool |
| 4.5 | `tools/metro-inspect-element.ts` | Element inspection tool with source resolution |
| 4.6 | End-to-end tests with a live Metro session |

### Phase 5: Integration & Polish

| Step | Description |
|---|---|
| 5.1 | Add all new tools to `GET /tools` listing with proper schemas |
| 5.2 | Add metro tools to MCP package (no changes needed — MCP proxies all tools automatically) |
| 5.3 | Add Claude Code skills for metro debugging workflow |
| 5.4 | Handle edge cases: Metro not running, app killed mid-session, multiple devices |
| 5.5 | Final integration test suite |

---

## 9. Test Suite

### 9.1 Unit Tests (vitest, mocked)

Located in `packages/tools/test/metro/`:

| Test File | Covers |
|---|---|
| `discovery.test.ts` | `discoverMetro()` with mocked fetch: valid Metro, down server, no targets, missing header |
| `target-selection.test.ts` | `selectTarget()`: Fusebox, C++ connection, legacy, fallback, Android/iOS URL normalization, multi-device filtering, Expo Go candidate ordering |
| `cdp-client.test.ts` | `CDPClient`: connect, send/response, timeout, evaluate, binding, disconnect, `evaluateWithBinding` request-ID matching, concurrent binding dispatch, `scriptParsed` accumulation, domain tracking set |
| `source-resolver.test.ts` | `_debugStack` parsing, `/symbolicate` call, iOS `//&` normalization, Android hostname normalization, `node_modules` filtering, `readSourceFragment` line extraction |

### 9.2 Integration Tests (require live Metro session)

Located in `packages/tools/test/metro/integration/`:

These tests are gated behind an env var (`METRO_PORT`) and skip if no Metro is available.

| Test File | Covers |
|---|---|
| `connection.test.ts` | Full discovery → connect → evaluate → disconnect cycle |
| `debugger.test.ts` | Debugger.enable, set/remove breakpoint, pause/resume |
| `inspector.test.ts` | Component tree fetch, inspect at (x,y), source resolution |
| `lifecycle.test.ts` | Service teardown on disconnect, re-resolve after error |

### 9.3 CDP Verification Script

`packages/tools/test/metro-cdp-verify.ts` — standalone script to manually verify CDP capabilities against a live session. Run before Phase 3 to confirm which Debugger domain methods work in Hermes.

---

## 10. Open Questions & Risks

### 10.1 Debugger Domain in Hermes (Fusebox)

Hermes's CDP implementation is handled by `HermesRuntimeAgentDelegate` which delegates to the Hermes `CDPAgent`. The React Native source confirms the following methods are used in tests and production code:

| Method | Confirmed | Evidence |
|---|---|---|
| `Debugger.enable` | Yes | `CDPSession.ts`, `JsiIntegrationTest` |
| `Debugger.setBreakpointByUrl` | Yes | `JsiIntegrationTest`, InspectorProxy URL rewriting |
| `Debugger.removeBreakpoint` | Yes | Radon `BreakpointsController` |
| `Debugger.pause` | Yes (inferred) | Hermes CDPAgent handles full Debugger domain |
| `Debugger.resume` | Yes | `HostTarget.cpp`, `Device.js` (legacy reload) |
| `Debugger.stepOver` | Yes | `HostTarget.cpp`, `HostTargetTest` |
| `Debugger.stepInto` / `stepOut` | Yes (inferred) | Part of standard Hermes Debugger domain |
| `Debugger.evaluateOnCallFrame` | Likely | Standard Hermes Debugger method; needs live verification |
| `Debugger.setPauseOnExceptions` | Yes | Radon `CDPSession.setUpDebugger` |
| `Debugger.setAsyncCallStackDepth` | Yes | Radon `CDPSession.setUpDebugger` (with `.catch(ignoreError)`) |

**InspectorProxy behavior**: For Fusebox targets (`nativeSourceCodeFetching: true`), the proxy passes CDP messages through mostly unchanged. For legacy targets, it rewrites URLs in `Debugger.setBreakpointByUrl` and `Debugger.scriptParsed` events. Our implementation should work with both paths since we normalize URLs ourselves.

**Mitigation**: The Phase 3 verification script will test all methods against a live session. If any are unsupported, we adapt the tool to use the closest working alternative.

### 10.2 Single Connection Limit

Metro's CDP proxy allows one debugger per page. If the user has Chrome DevTools or another debugger connected, our connection will either fail or disconnect the existing one.

**Mitigation**: 
- Check for an existing connection before connecting (attempt `/json/list` and look for `devtoolsFrontendUrl` presence)
- Return a clear error message if the connection fails due to an existing debugger
- Document this as a known limitation

### 10.3 React Version Compatibility

The fiber tree walking and `_debugStack` approach require:
- React 18+ for `_debugStack` (available in dev mode)
- `__REACT_DEVTOOLS_GLOBAL_HOOK__` (available in all dev builds)
- Fabric (New Architecture) for `UIManager.measureInWindow` to be synchronous

**Mitigation**: Detect React version via `React.version` evaluation and adjust scripts accordingly. Old architecture fallback uses async measurement with the binding push pattern.

### 10.4 Source Maps in Monorepos

Metro `POST /symbolicate` returns absolute paths. For monorepos, the project root from `X-React-Native-Project-Root` might not be the workspace root.

**Mitigation**: The source resolver strips the project root prefix and returns relative paths. For reading source fragments, it uses the absolute path returned by symbolication directly.

### 10.5 Expo Prelude Line Offset

Expo apps inject a `__env__` prelude module that is not present in the source map. This shifts all line numbers in the bundle by the number of lines in the prelude. Radon handles this by reading `RNIDE_expo_env_prelude_lines` events from its custom Metro reporter and applying `expoPreludeLineCount` as an offset during source map processing.

**Impact**: Breakpoints set via `Debugger.setBreakpointByUrl` may land on the wrong line in Expo apps. Source symbolication via `POST /symbolicate` should still work correctly since Metro applies the offset internally.

**Mitigation (v1)**: Document as a known limitation for Expo apps. If breakpoints are off by a constant number of lines, the offset can be auto-detected by checking whether `__env__` appears in the source map's `sources` array (available from `Debugger.scriptParsed` sourceMapURL). Full support requires fetching the source map and computing the offset.

### 10.6 Fast Refresh / HMR Breakpoint Invalidation

When Hot Module Replacement (Fast Refresh) occurs, the app's JS modules are re-evaluated. Breakpoints set via `Debugger.setBreakpointByUrl` may:
- Continue to work if the file and line number did not change
- Land on a different line if code was inserted/removed above the breakpoint
- Become invalid if the file was renamed or the module was removed

Radon has breakpoint retry logic tied to Fast Refresh events, re-setting breakpoints after each HMR cycle.

**Mitigation (v1)**: Document the limitation. Users should re-set breakpoints after a hot reload if they observe unexpected behavior. A future enhancement can listen for `Debugger.scriptParsed` events during HMR (new scripts are emitted when modules are re-evaluated) and re-apply breakpoints.

### 10.7 Multi-Device Ambiguity

When multiple devices are connected to the same Metro port (e.g. simulator + physical device), `MetroDebugger:{port}` always selects the first matching target. The user has no way to choose a specific device.

**Mitigation (v1)**: Add an optional `deviceId` parameter to `metro-connect` and other tools, passed as `options.deviceId` to the blueprint factory. The target selection logic (section 4.2) uses it to filter candidates. The URN remains `MetroDebugger:{port}` — if a user needs to switch devices on the same port, the existing service must be torn down first (by calling `registry.dispose()` or waiting for disconnection).

**Future (v2)**: Extend URN to `MetroDebugger:{port}:{deviceId}` to support concurrent connections to different devices on the same port. This requires changes to the registry's URN parsing and is deferred.

---

## 11. Relationship to Existing Architecture

| Concept | Existing (SimulatorServer) | New (MetroDebugger) |
|---|---|---|
| Blueprint namespace | `SimulatorServer` | `MetroDebugger` |
| URN payload | UDID string | Port number string |
| Factory behavior | Spawns a child process | Opens HTTP+WebSocket connections |
| API surface | `{ apiUrl, streamUrl }` | `{ cdp, sourceResolver, port, projectRoot, ... }` |
| Termination trigger | Process exit | WebSocket close |
| Tools declare dependency | `SimulatorServer:${udid}` | `MetroDebugger:${port}` |
| Options passed at resolve | `{ token }` | None needed |

The patterns are identical. A tool that needs both simulator control and debugger access declares both dependencies:

```typescript
services: (params) => ({
  simulatorServer: `SimulatorServer:${params.udid}`,
  metroDebugger: `MetroDebugger:${params.metroPort}`,
})
```

---

## 12. Future Extensions

These are out of scope for the initial implementation but the architecture supports them:

- **Network interception**: `Network.enable` + request/response inspection via CDP
- **Performance profiling**: `Profiler.start` / `Profiler.stop` + sampling
- **Console capture**: `Runtime.consoleAPICalled` events → log aggregation
- **Render highlighting in UI**: Push render events via WebSocket to the UI package for overlay rendering on the device screen
- **Conditional auto-connect**: Watch for Metro to start and auto-connect when tools are first invoked
- **Multi-device**: Multiple pages in `/json/list` → extend URN to `MetroDebugger:{port}:{deviceId}`
