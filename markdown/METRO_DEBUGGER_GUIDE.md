# Metro Debugger Communication & Breakpoint Resolution

This document explains how the tools communicate with the React Native Metro
debugger via the Chrome DevTools Protocol (CDP) and, critically, how breakpoints
are correctly resolved using source maps.

---

## Architecture Overview

```
┌──────────────┐      HTTP       ┌──────────────┐      WebSocket/CDP      ┌─────────────┐
│  radon-lite  │ ───────────────>│  Metro Server │ ────────────────────────>│  Hermes VM  │
│  (tools)     │  /json/list     │  :8081        │  /inspector/debug?...   │  (on device) │
│              │  /status        │               │                         │              │
│              │  /symbolicate   │               │                         │              │
└──────────────┘                 └──────────────┘                         └─────────────┘
```

### Connection Flow

1. **Discovery** (`discoverMetro`): Fetch `http://localhost:{port}/status` to
  verify Metro is running and get the `X-React-Native-Project-Root` header.
   Then fetch `/json/list` to enumerate CDP targets.
2. **Target Selection** (`selectTarget`): Pick the best CDP target. Priority:
  - `prefersFuseboxFrontend === true` (RN >= 0.76, new Hermes debugger)
  - Description ending with `[C++ connection]`
  - Title starting with `React Native Bridge` (legacy)
  - Fallback to first target
3. **CDP Connection**: Open a WebSocket to the target's
  `webSocketDebuggerUrl`. Enable required domains:
  - `Runtime.enable` — needed for `evaluate`, binding calls
  - `Debugger.enable` — triggers `Debugger.scriptParsed` events, enables
  breakpoints/pause/step
  - `Debugger.setPauseOnExceptions` — configure exception behavior
  - `Runtime.addBinding("__radon_lite_callback")` — for async script evaluation
4. **Source Map Loading**: As `Debugger.enable` is called, the runtime emits
  `Debugger.scriptParsed` events for all loaded scripts. Each event includes:
  - `scriptId` — unique identifier for the script
  - `url` — the bundle URL (e.g., `http://localhost:8081/index.bundle//&platform=ios&...`)
  - `sourceMapURL` — URL to fetch the V3 source map
   The `SourceMapsRegistry` listens for these events, fetches each source map,
   and parses it using `source-map-js`.

---

## Breakpoint Resolution (The Core Fix)

### The Problem

The Metro bundler produces a single JavaScript bundle (e.g.,
`http://localhost:8081/index.bundle?...`) containing all modules. The Hermes
runtime only knows about this bundle — it has no concept of individual source
files like `App.tsx`.

The **incorrect** approach was to set breakpoints using a fabricated URL:

```typescript
// WRONG — this URL doesn't exist in the runtime
const url = `http://localhost:8081/App.tsx`;
await cdp.send("Debugger.setBreakpointByUrl", { url, lineNumber: 21 });
// Result: breakpoint is "set" (gets an ID) but has ZERO resolved locations
// and will NEVER trigger
```

### The Correct Approach

Breakpoints must be set at the **generated position** in the **bundle**, not at
the original source position. This requires a source map reverse lookup:

```
Original:   App.tsx:21:0              (what the user specifies)
     ↓  source map reverse lookup
Generated:  index.bundle:99926:4      (where the code actually lives)
     ↓  CDP call
Debugger.setBreakpointByUrl({
  url: "http://localhost:8081/index.bundle//&platform=ios&...",
  lineNumber: 99925,  // CDP uses 0-based line numbers
  columnNumber: 4
})
```

The result includes `locations` — an array of resolved script positions. A
non-empty `locations` array confirms the breakpoint was correctly placed.

### Source Map Path Formats

Metro source maps use different path formats depending on bundle parameters:


| Bundle parameter                               | Source paths in map | Example                       |
| ---------------------------------------------- | ------------------- | ----------------------------- |
| `sourcePaths=url-server` (default for Fusebox) | Aliased paths       | `/[metro-project]/App.tsx`    |
| No `sourcePaths`                               | Absolute file paths | `/Users/.../test_app/App.tsx` |


The `SourceMapsRegistry.toGeneratedPosition()` handles both formats by trying
multiple candidate paths:

1. Aliased: `/[metro-project]/{relativePath}`
2. Absolute: `{projectRoot}/{relativePath}`
3. Suffix match: any source entry ending with `/{relativePath}`

### Implementation

```typescript
// In SourceMapsRegistry:
const generated = sourceMaps.toGeneratedPosition("App.tsx", 21, 0);
// Returns: {
//   scriptUrl: "http://localhost:8081/index.bundle//&platform=ios&...",
//   scriptId: "2",
//   line1Based: 99927,    // line in the bundle (1-based)
//   column0Based: 4       // column in the bundle (0-based)
// }

// Then set the breakpoint with the BUNDLE URL and GENERATED position:
await cdp.send("Debugger.setBreakpointByUrl", {
  url: generated.scriptUrl,
  lineNumber: generated.line1Based - 1,  // CDP is 0-based
  columnNumber: generated.column0Based,
});
```

---

## CDP Commands Reference

### Breakpoint Commands


| Command                       | Purpose                           | Notes                                                       |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `Debugger.setBreakpointByUrl` | Set breakpoint by URL + line      | **Primary method**. Use bundle URL + generated position.    |
| `Debugger.removeBreakpoint`   | Remove a breakpoint by ID         | Uses `breakpointId` from set response.                      |
| `Debugger.setBreakpoint`      | Set breakpoint by scriptId + line | **Not supported by Hermes/Fusebox** — returns error -32000. |


### Execution Control


| Command             | Purpose                       | Notes                                   |
| ------------------- | ----------------------------- | --------------------------------------- |
| `Debugger.pause`    | Pause JS execution            | Only works when JS is actively running. |
| `Debugger.resume`   | Resume after pause/breakpoint |                                         |
| `Debugger.stepOver` | Step to next line             | Requires paused state.                  |
| `Debugger.stepInto` | Step into function call       | Requires paused state.                  |
| `Debugger.stepOut`  | Step out of current function  | Requires paused state.                  |


### Events


| Event                   | Trigger                          | Payload                           |
| ----------------------- | -------------------------------- | --------------------------------- |
| `Debugger.scriptParsed` | Script loaded by runtime         | `scriptId`, `url`, `sourceMapURL` |
| `Debugger.paused`       | Breakpoint hit or `pause` called | `reason`, `callFrames[]`          |
| `Runtime.bindingCalled` | JS calls a registered binding    | `name`, `payload`                 |


---

## Source Map Handling

### Fetching

Source maps are fetched when `Debugger.scriptParsed` events fire. Two formats
are supported:

1. **HTTP URL**: `http://localhost:8081/index.map?platform=ios&dev=true&...`
  — fetched via `fetch()`.
2. **Data URL**: `data:application/json;base64,...` — decoded directly from
  the base64 payload.

### Reverse Lookup (`original → generated`)

Used for **setting breakpoints**. Given a source file path and line number,
find the corresponding position in the bundle.

```typescript
const consumer = new SourceMapConsumer(sourceMapData);
const generatedPos = consumer.generatedPositionFor({
  source: "/[metro-project]/App.tsx",
  line: 21,       // 1-based
  column: 0,      // 0-based
  bias: SourceMapConsumer.LEAST_UPPER_BOUND,
});
// generatedPos.line = 99927 (1-based position in bundle)
```

The `LEAST_UPPER_BOUND` bias finds the nearest mapped position at or after the
requested line, which handles empty lines and comments correctly.

### Forward Lookup (`generated → original`)

Used for **symbolicating stack frames** (e.g., when paused at a breakpoint).
This uses Metro's `/symbolicate` endpoint:

```typescript
const res = await fetch(`http://localhost:${port}/symbolicate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    stack: [{ file: bundleUrl, lineNumber, column, methodName }],
  }),
});
const data = await res.json();
// data.stack[0] = { file: "/Users/.../App.tsx", lineNumber: 21, column: 0 }
```

---

## Key Files


| File                                   | Purpose                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/metro/source-maps.ts`             | `SourceMapsRegistry` — fetches, parses, and queries source maps for breakpoint resolution |
| `src/metro/cdp-client.ts`              | `CDPClient` — WebSocket CDP connection, command/response handling, event emission         |
| `src/metro/source-resolver.ts`         | `SourceResolver` — forward symbolication (generated→original) via Metro `/symbolicate`    |
| `src/metro/discovery.ts`               | Metro server discovery and CDP target enumeration                                         |
| `src/metro/target-selection.ts`        | CDP target selection logic                                                                |
| `src/blueprints/metro-debugger.ts`     | Service blueprint — orchestrates connection, domain enable, source map loading            |
| `src/tools/metro-set-breakpoint.ts`    | Set breakpoint tool — uses `SourceMapsRegistry` for correct resolution                    |
| `src/tools/metro-remove-breakpoint.ts` | Remove breakpoint by ID                                                                   |
| `src/tools/metro-pause.ts`             | Pause execution, returns source-mapped call frames                                        |
| `src/tools/metro-step.ts`              | Step over/into/out, returns source-mapped location                                        |


---

## Hermes/Fusebox Specifics (RN >= 0.76)

- The new debugger uses the Fusebox protocol layered on top of CDP
- `Debugger.setBreakpoint` (scriptId-based) is **not supported** — always use
`Debugger.setBreakpointByUrl`
- Source maps use `/[metro-project]/` aliased paths when `sourcePaths=url-server`
is in the bundle URL (default for Fusebox connections)
- `FuseboxClient.setClientMetadata` should be called to register as a debugger
client (non-fatal if unsupported)
- `ReactNativeApplication.enable` activates RN-specific CDP extensions

---

## Troubleshooting

**Breakpoint set but not hit:**

- Verify `locations` array in the response is non-empty
- If empty, the source map lookup likely failed — check file path format
- Ensure source maps are loaded (`waitForPending()`)

**Cannot resolve source position:**

- Check the source file is included in the bundle (not tree-shaken)
- Verify the file path relative to project root
- Check the source map `sources` array for the expected path format

**CDP connection refused:**

- Verify Metro is running: `curl http://localhost:8081/status`
- Check for existing debugger connections (only one allowed per target)
- Verify target device is connected: check `/json/list` response

