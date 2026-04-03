# RFC: Fix react-profiler stability after Metro reload/restart

**Branch:** `ios-instruments-profiler`
**Files changed:**

- `packages/registry/src/registry.ts`
- `packages/tool-server/src/tools/profiler/react/react-profiler-start.ts`
- `packages/tool-server/src/tools/profiler/react/react-profiler-stop.ts`
- `packages/tool-server/src/utils/setup-registry.ts`

---

## Problem

When a developer makes code changes and Metro hot-reloads (or fully restarts), the Hermes WebSocket closes. This triggers an async cascade in the registry that moves `JsRuntimeDebugger:8081` and `ReactProfilerSession:8081` to ERROR state.

Both `react-profiler-start` and `react-profiler-stop` used a `services` callback that made the registry auto-resolve `ReactProfilerSession:<port>` before `execute()` ran. This created two distinct failure modes:

### react-profiler-start (second invocation)

After the first profiling session ends and the CDP disconnects, both services move to ERROR. When `react-profiler-start` is called again, the `services` auto-resolution triggers re-initialization. During re-init, the JsRuntimeDebugger factory completes and registers its `terminated` event listener. If the CDP drops while the ReactProfilerSession factory is still running, the termination cascades to ReactProfilerSession (changing it from STARTING to TERMINATING), and the `_initialize` guard throws "Service was terminated during initialization" — before `execute()` ever runs. The reconnect logic in `execute()` was never reached.

### react-profiler-stop (after Metro reload)

After a Metro reload, both services are in ERROR. The `services` auto-resolution in `react-profiler-stop` tried to re-initialize the session, which required JsRuntimeDebugger, which called `discoverMetro()` — failing with "no CDP targets". But there is nothing to collect after a reload anyway (in-flight profiling data is lost), so re-initialization is the wrong approach.

There was also a secondary race in the registry itself: if a blueprint factory was executing (`STARTING`) when a cascade fired, `_initialize` would unconditionally call `_transition(node, RUNNING)` after the factory completed — even though the cascade had already moved the node to ERROR. This produced a phantom RUNNING service with a disconnected CDP.

---

## Fix 1 — Registry: guard against mid-init termination

**File:** `packages/registry/src/registry.ts`, `_initialize` method

After `await blueprint.factory(...)` returns, the node state is checked before applying the result:

```typescript
const instance = await blueprint.factory(resolvedDeps, payload, options);

// Guard: if the node was terminated while factory was running, discard the new instance
if (node.state !== ServiceState.STARTING) {
  try {
    await instance.dispose();
  } catch {
    /* ignore */
  }
  node.initPromise = null;
  throw new ServiceInitializationError(urn, "Service was terminated during initialization");
}

this._transition(node, ServiceState.RUNNING);
node.instance = instance as ServiceInstance;
```

If any state other than `STARTING` is observed (e.g. ERROR from a cascade), the orphaned instance is disposed and init fails cleanly. The error propagates to the caller like any other factory error — the registry node ends up in ERROR, not phantom RUNNING.

---

## Fix 2 — react-profiler-start: manual resolution with pre-cleanup

**File:** `packages/tool-server/src/tools/profiler/react/react-profiler-start.ts`

The tool uses `services: () => ({})` to prevent auto-resolution and resolves manually in `execute()`. Before resolving, it inspects service states via `registry.getSnapshot()` and pre-cleans any non-healthy services (ERROR, STARTING, TERMINATING) so that `resolveService` starts fresh.

```typescript
services: () => ({}),
async execute(_services, params) {
  const jsdUrn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${params.port}`;
  const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`;

  async function disposeAndWait() {
    try { await registry.disposeService(psUrn); } catch { /* ignore */ }
    try { await registry.disposeService(jsdUrn); } catch { /* ignore */ }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const jsdState = safeGetState(registry, jsdUrn);
      const psState = safeGetState(registry, psUrn);
      if (jsdState !== ServiceState.TERMINATING && psState !== ServiceState.TERMINATING) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Pre-clean: if either service is in a non-healthy state, dispose both so
  // resolveService starts fresh instead of hitting "terminated during init".
  const snapshot = registry.getSnapshot();
  const psEntry = snapshot.services.get(psUrn);
  const jsdEntry = snapshot.services.get(jsdUrn);
  if (
    (psEntry && psEntry.state !== ServiceState.RUNNING && psEntry.state !== ServiceState.IDLE) ||
    (jsdEntry && jsdEntry.state !== ServiceState.RUNNING && jsdEntry.state !== ServiceState.IDLE)
  ) {
    await disposeAndWait();
  }

  let api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);

  if (!api.cdp.isConnected()) {
    await disposeAndWait();
    api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);

    if (!api.cdp.isConnected()) {
      throw new Error(
        "CDP connection not available. The Hermes runtime may still be loading. Call react-profiler-start again.",
      );
    }
  }

  const cdp = api.cdp; // captured after potential reconnect
```

This avoids the "terminated during initialization" error because the tool controls resolution timing and ensures stale services are fully disposed before attempting re-creation.

---

## Fix 3 — react-profiler-stop: manual resolution with state guard

**File:** `packages/tool-server/src/tools/profiler/react/react-profiler-stop.ts`

Converted from an exported constant `reactProfilerStopTool` to a factory function `createReactProfilerStopTool(registry)`.

Uses `services: () => ({})` to prevent auto-resolution. Before any work, checks the service state via `registry.getSnapshot()`:

- If not RUNNING → throws a clear error: "No active profiling session. The session may have been lost due to a Metro reload."
- If RUNNING → resolves manually via `registry.resolveService()`, then proceeds with existing collection logic.

```typescript
services: () => ({}),
async execute(_services, params) {
  const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`;
  const snapshot = registry.getSnapshot();
  const entry = snapshot.services.get(psUrn);

  if (!entry || entry.state !== ServiceState.RUNNING) {
    throw new Error(
      "No active profiling session. The session may have been lost due to a Metro reload. " +
        "Call react-profiler-start to begin a new session.",
    );
  }

  const api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);
  // ... rest of existing collection logic unchanged
```

This prevents `stop` from attempting to re-create a dead session — if the session was lost, the in-flight profiling data (CPU samples, commit captures) is gone and there's nothing to collect.

---

## Fix 4 — setup-registry: wire up both factories

**File:** `packages/tool-server/src/utils/setup-registry.ts`

```typescript
// Before
registry.registerTool(reactProfilerStartTool);
registry.registerTool(reactProfilerStopTool);

// After
registry.registerTool(createReactProfilerStartTool(registry));
registry.registerTool(createReactProfilerStopTool(registry));
```

---

## Expected behavior after these changes

| Scenario                                                           | Before                                                                          | After                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Metro hot-reload, call `react-profiler-start` immediately          | Fails with "call again to reconnect"; re-call hits stale RUNNING or TERMINATING | Auto-disposes stale services, waits for settle, re-resolves — succeeds in one call    |
| Metro fully restarted, call `react-profiler-start`                 | Same failure loop                                                               | Same auto-reconnect; one retry needed only if Hermes is still booting                 |
| Second `react-profiler-start` after first session ends + CDP drops | "Service was terminated during initialization"                                  | Pre-cleans ERROR services before resolving — succeeds in one call                     |
| `react-profiler-stop` after Metro reload                           | Crashes: "no CDP targets" (tries to re-create dead session)                     | Clean error: "No active profiling session" with guidance to start a new one           |
| Blueprint factory interrupted mid-init by cascade                  | Node left in phantom RUNNING state                                              | Factory result discarded, node correctly in ERROR, next `resolveService` starts fresh |

### Blueprint dispose

`ReactProfilerSession.dispose` calls `Profiler.disable` (best-effort, errors caught) to match the `Profiler.enable` in the factory. This is a single CDP call with `.catch(ignore)`, so it does not meaningfully delay TERMINATING→IDLE. If CDP is already disconnected (e.g. after a Metro reload), the call silently fails.

---

## Testing

Unit tests: `cd packages/registry && npx vitest run` (38/38 pass)
Integration: `cd packages/tool-server && npx vitest run` (pre-existing 3 failures in `integration.test.ts` unrelated to this change)

Manual verification steps:

1. Start profiling, trigger Metro reload (`debugger-reload-metro`), immediately call `react-profiler-start` → should succeed without retries.
2. Start profiling, fully restart Metro process, call `react-profiler-start` → should succeed (or fail with "still loading" message requiring at most one retry).
3. Start profiling → stop → wait for CDP to drop → start again → should succeed (pre-cleanup disposes ERROR services).
4. Start profiling → Metro reload → call `react-profiler-stop` → should get clear "No active profiling session" message instead of "no CDP targets" crash.
5. Start profiling → exercise app → call `react-profiler-stop` (no reload) → should work normally.
