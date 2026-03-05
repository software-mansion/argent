# CDP Debugger Domain — Verification Guide

This document describes how to verify that the Chrome DevTools Protocol (CDP) Debugger domain methods work correctly against Hermes (React Native's JS engine) via Metro's CDP proxy. These tests should be run **before implementing Phase 3** (breakpoints & debugger control) of the Metro Debugger Service plan.

---

## Prerequisites

1. A React Native app running in debug mode on a simulator or device
2. Metro dev server running (typically port 8081)
3. Node.js 18+ (for native `fetch` and `WebSocket`)

## Setup

```bash
# 1. Confirm Metro is running
curl http://localhost:8081/status
# Expected: packager-status:running

# 2. Get the CDP target
curl http://localhost:8081/json/list | jq '.[0].webSocketDebuggerUrl'
# Expected: ws://localhost:8081/inspector/debug?device=...&page=...
```

---

## Test 1: Runtime.enable + Runtime.evaluate (Baseline)

This should already work (verified in prior research). Run as a sanity check.

```javascript
const ws = new WebSocket("ws://localhost:8081/inspector/debug?device=DEVICE&page=PAGE");

ws.on("open", () => {
  ws.send(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} }));
  ws.send(JSON.stringify({
    id: 2,
    method: "Runtime.evaluate",
    params: { expression: "1 + 1" }
  }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id === 2) {
    console.log("Runtime.evaluate result:", msg.result);
    // Expected: { result: { type: "number", value: 2 } }
  }
});
```

**Pass criteria**: `msg.result.result.value === 2`

---

## Test 2: Debugger.enable

```javascript
ws.send(JSON.stringify({ id: 10, method: "Debugger.enable", params: { maxScriptsCacheSize: 100000000 } }));
```

**Expected response**:
```json
{ "id": 10, "result": { "debuggerId": "some-id" } }
```

**Expected side effects**: Multiple `Debugger.scriptParsed` events will fire, one per loaded module/script. Each has:
```json
{
  "method": "Debugger.scriptParsed",
  "params": {
    "scriptId": "42",
    "url": "http://localhost:8081/index.bundle?platform=ios&dev=true&...",
    "startLine": 0,
    "startColumn": 0,
    "endLine": 99999,
    "endColumn": 0,
    "sourceMapURL": "..."
  }
}
```

**What to record**:
- [ ] Does `Debugger.enable` succeed? (response has `result`, no `error`)
- [ ] How many `scriptParsed` events fire?
- [ ] What do the `url` fields look like? (Are they bundle URLs? Per-module URLs?)
- [ ] Is `sourceMapURL` present?
- [ ] Does `Debugger.enable` work alongside `Runtime.enable`?

---

## Test 3: Debugger.setBreakpointByUrl

After `Debugger.enable` succeeds, set a breakpoint using a URL regex:

```javascript
ws.send(JSON.stringify({
  id: 20,
  method: "Debugger.setBreakpointByUrl",
  params: {
    lineNumber: 20,        // 0-based line number in the ORIGINAL source
    urlRegex: ".*App\\.tsx$",
    columnNumber: 0
  }
}));
```

**Expected response**:
```json
{
  "id": 20,
  "result": {
    "breakpointId": "1:20:0:.*App\\.tsx$",
    "locations": [
      { "scriptId": "42", "lineNumber": 20, "columnNumber": 0 }
    ]
  }
}
```

**What to record**:
- [ ] Does the method return a `breakpointId`?
- [ ] Are `locations` populated (i.e., did the regex match a loaded script)?
- [ ] If locations are empty, try different `urlRegex` patterns:
  - `".*App\\.tsx"` (no `$`)
  - `"App\\.tsx"` (no `.*` prefix)
  - The full bundle URL from `scriptParsed`
  - A substring of the bundle URL
- [ ] Does `lineNumber` refer to the source-mapped line or the bundle line?

**Important**: Hermes may interpret `lineNumber` as a bundle line (pre-source-map) or as a source-mapped line depending on the CDP implementation version. If source-mapped lines don't work, we need to reverse-symbolicate (map source file:line → bundle line) before setting breakpoints.

---

## Test 4: Debugger.setBreakpoint (by scriptId)

Alternative approach using an exact scriptId from `Debugger.scriptParsed`:

```javascript
// Use a scriptId captured from a scriptParsed event
ws.send(JSON.stringify({
  id: 21,
  method: "Debugger.setBreakpoint",
  params: {
    location: {
      scriptId: "CAPTURED_SCRIPT_ID",
      lineNumber: 500,    // a line number within the bundle
      columnNumber: 0
    }
  }
}));
```

**What to record**:
- [ ] Does this method work?
- [ ] Does the response include the resolved `actualLocation`?
- [ ] What coordinate space is `lineNumber` in? (bundle coordinates or source coordinates?)

---

## Test 5: Breakpoint Hit → Debugger.paused

After setting a breakpoint on a line that will execute (e.g., inside a component render function), trigger the code path (e.g., interact with the app to cause a re-render).

**Expected event**:
```json
{
  "method": "Debugger.paused",
  "params": {
    "callFrames": [
      {
        "callFrameId": "...",
        "functionName": "App",
        "location": { "scriptId": "42", "lineNumber": 20, "columnNumber": 0 },
        "scopeChain": [...]
      }
    ],
    "reason": "other",
    "hitBreakpoints": ["1:20:0:.*App\\.tsx$"]
  }
}
```

**What to record**:
- [ ] Does `Debugger.paused` fire when the breakpoint line executes?
- [ ] Does the app UI freeze? (Expected: yes)
- [ ] What does `callFrames[0].location` contain? (Bundle coords or source coords?)
- [ ] Is `scopeChain` populated with variable scopes?

---

## Test 6: Debugger.resume

While paused:

```javascript
ws.send(JSON.stringify({ id: 30, method: "Debugger.resume", params: {} }));
```

**Expected**:
- `Debugger.resumed` event fires
- App UI unfreezes

**What to record**:
- [ ] Does `resume` work?
- [ ] Does the app continue normally?

---

## Test 7: Step Operations

While paused:

```javascript
// Step over
ws.send(JSON.stringify({ id: 31, method: "Debugger.stepOver", params: {} }));
// Expected: Debugger.resumed → Debugger.paused at next line

// Step into
ws.send(JSON.stringify({ id: 32, method: "Debugger.stepInto", params: {} }));
// Expected: Debugger.resumed → Debugger.paused inside called function

// Step out
ws.send(JSON.stringify({ id: 33, method: "Debugger.stepOut", params: {} }));
// Expected: Debugger.resumed → Debugger.paused at caller
```

**What to record**:
- [ ] Does `stepOver` advance to the next line?
- [ ] Does `stepInto` enter function calls?
- [ ] Does `stepOut` return to the caller?
- [ ] Are the `callFrames` in `Debugger.paused` updated correctly?

---

## Test 8: Debugger.evaluateOnCallFrame

While paused, evaluate an expression in the context of the current call frame:

```javascript
ws.send(JSON.stringify({
  id: 40,
  method: "Debugger.evaluateOnCallFrame",
  params: {
    callFrameId: "CAPTURED_CALL_FRAME_ID",
    expression: "this"
  }
}));
```

**What to record**:
- [ ] Does this method exist in Hermes CDP?
- [ ] Can we inspect local variables via scope objects?
- [ ] If not available, does `Runtime.evaluate` still work while paused?

---

## Test 9: Debugger.removeBreakpoint

```javascript
ws.send(JSON.stringify({
  id: 50,
  method: "Debugger.removeBreakpoint",
  params: { breakpointId: "CAPTURED_BREAKPOINT_ID" }
}));
```

**What to record**:
- [ ] Does the breakpoint get removed (no longer fires)?
- [ ] Does the method return successfully?

---

## Test 10: Concurrent Runtime + Debugger Usage

Verify that after `Debugger.enable`, we can still use `Runtime.evaluate` for inspector scripts:

```javascript
// While Debugger is enabled (not paused):
ws.send(JSON.stringify({
  id: 60,
  method: "Runtime.evaluate",
  params: { expression: "Object.keys(window.__REACT_DEVTOOLS_GLOBAL_HOOK__)" }
}));
```

**What to record**:
- [ ] Does `Runtime.evaluate` work while `Debugger` is enabled?
- [ ] Does it work while the debugger is paused? (Important for inspector tools during breakpoint)

---

## Test 11: Source Map Coordinate Space

This is critical for the breakpoint tool. We need to determine whether Hermes CDP uses:

**Option A: Source-mapped coordinates** — `lineNumber` in `setBreakpointByUrl` refers to the original `.tsx` file line
**Option B: Bundle coordinates** — `lineNumber` refers to the line in the compiled `index.bundle`

To determine this:

1. Find a known function in your source (e.g., `App.tsx` line 20)
2. Look up what bundle line it maps to using `POST /symbolicate` in reverse:
   ```bash
   curl -X POST http://localhost:8081/symbolicate \
     -H "Content-Type: application/json" \
     -d '{"stack":[{"file":"http://localhost:8081/index.bundle?platform=ios&dev=true","lineNumber":20,"column":0,"methodName":"test"}]}'
   ```
3. Try `setBreakpointByUrl` with both the source line (20) and the bundle line
4. See which one actually sets the breakpoint (has locations in the response and fires `Debugger.paused`)

If Hermes uses bundle coordinates, we'll need to:
1. Fetch the source map from Metro (GET the URL in `sourceMapURL` from `scriptParsed`)
2. Use a source-map library to map file:line → bundle line
3. Set the breakpoint at the bundle line

This adds complexity but is solvable. The `source-map` npm package handles this.

---

## Running the Verification

The test script at `packages/tools/test/metro-cdp-verify.ts` will automate all of the above:

```bash
# Start a React Native app + Metro, then:
cd packages/tools
METRO_PORT=8081 npx ts-node test/metro-cdp-verify.ts
```

The script will:
1. Connect to Metro
2. Run each test in sequence
3. Print a results table with pass/fail for each test
4. Output the raw responses for manual inspection
5. Generate a `cdp-verification-results.json` file

---

## Decision Matrix

After running verification, use this matrix to finalize the implementation:

| Question | If Yes | If No |
|---|---|---|
| `Debugger.enable` works? | Proceed with Phase 3 as planned | **Blocker** — investigate alternative CDP impl |
| `setBreakpointByUrl` with urlRegex works? | Use regex-based approach | Fall back to `setBreakpoint` with scriptId |
| Coordinates are source-mapped? | Direct file:line mapping | Add source-map reverse lookup step |
| `evaluateOnCallFrame` works? | Add to `metro-evaluate` as option | Use `Runtime.evaluate` (global scope only) |
| `Runtime.evaluate` works while paused? | Inspector tools work during breakpoint | Warn user that inspect/tree unavailable while paused |
| Step operations work? | Implement `metro-step` tool | Remove tool, document limitation |
