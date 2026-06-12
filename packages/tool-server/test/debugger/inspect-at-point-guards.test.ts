import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSPECT_NO_DEVTOOLS_HOOK_ERROR,
  INSPECT_NO_FIBER_ROOT_ERROR,
  INSPECT_NO_RENDERER_ERROR,
  makeInspectScript,
} from "../../src/utils/debugger/scripts/inspect-at-point";

/**
 * The script is generated as a JS source string injected into the Hermes
 * runtime via CDP `Runtime.evaluate`. The guards we add here are the only
 * thing standing between a release build (where __REACT_DEVTOOLS_GLOBAL_HOOK__
 * is stripped) and a generic `Cannot read property 'renderers' of undefined`
 * TypeError surfacing to the operator. Eval the script against a controlled
 * `globalThis` to verify each guard fires the verbose diagnostic.
 */

interface InspectErrorPayload {
  requestId: string;
  type: "inspect_result";
  error: string;
}

function evalIIFE(script: string): unknown {
  return (0, eval)(script);
}

function withGlobals(setup: () => void, body: () => void) {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    hook: g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    callback: g.__argent_callback,
    nativeFabric: g.nativeFabricUIManager,
    window: g.window,
  };
  try {
    setup();
    body();
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved.hook;
    g.__argent_callback = saved.callback;
    g.nativeFabricUIManager = saved.nativeFabric;
    g.window = saved.window;
  }
}

function makeCallbackSink(): {
  spy: ReturnType<typeof vi.fn>;
  lastPayload: () => InspectErrorPayload | null;
} {
  const spy = vi.fn();
  return {
    spy,
    lastPayload: () => {
      const lastCall = spy.mock.calls.at(-1);
      if (!lastCall) return null;
      return JSON.parse(lastCall[0] as string) as InspectErrorPayload;
    },
  };
}

const REQ = "req-test-123";

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__argent_callback;
});

describe("makeInspectScript — production-build guards", () => {
  it("emits verbose hook-missing error when __REACT_DEVTOOLS_GLOBAL_HOOK__ is undefined", () => {
    const sink = makeCallbackSink();
    withGlobals(
      () => {
        const g = globalThis as Record<string, unknown>;
        g.__argent_callback = sink.spy;
        delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      },
      () => {
        evalIIFE(makeInspectScript(100, 200, REQ));
        const payload = sink.lastPayload();
        expect(payload).not.toBeNull();
        expect(payload?.requestId).toBe(REQ);
        expect(payload?.type).toBe("inspect_result");
        expect(payload?.error).toBe(INSPECT_NO_DEVTOOLS_HOOK_ERROR);
      }
    );
  });

  it("emits verbose renderer-missing error when hook has no renderers map", () => {
    const sink = makeCallbackSink();
    withGlobals(
      () => {
        const g = globalThis as Record<string, unknown>;
        g.__argent_callback = sink.spy;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
      },
      () => {
        evalIIFE(makeInspectScript(100, 200, REQ));
        const payload = sink.lastPayload();
        expect(payload?.error).toBe(INSPECT_NO_RENDERER_ERROR);
      }
    );
  });

  it("emits verbose renderer-missing error when renderers map is empty", () => {
    const sink = makeCallbackSink();
    withGlobals(
      () => {
        const g = globalThis as Record<string, unknown>;
        g.__argent_callback = sink.spy;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map() };
      },
      () => {
        evalIIFE(makeInspectScript(100, 200, REQ));
        const payload = sink.lastPayload();
        expect(payload?.error).toBe(INSPECT_NO_RENDERER_ERROR);
      }
    );
  });

  it("emits verbose fiber-root error when getFiberRoots returns empty", () => {
    const sink = makeCallbackSink();
    withGlobals(
      () => {
        const g = globalThis as Record<string, unknown>;
        g.__argent_callback = sink.spy;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          renderers: new Map([[1, { rendererConfig: {} }]]),
          getFiberRoots: () => new Set(),
        };
      },
      () => {
        evalIIFE(makeInspectScript(100, 200, REQ));
        const payload = sink.lastPayload();
        expect(payload?.error).toBe(INSPECT_NO_FIBER_ROOT_ERROR);
      }
    );
  });

  it("emits verbose renderer-missing error when getFiberRoots is not a function", () => {
    const sink = makeCallbackSink();
    withGlobals(
      () => {
        const g = globalThis as Record<string, unknown>;
        g.__argent_callback = sink.spy;
        g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          renderers: new Map([[1, { rendererConfig: {} }]]),
        };
      },
      () => {
        evalIIFE(makeInspectScript(100, 200, REQ));
        const payload = sink.lastPayload();
        expect(payload?.error).toBe(INSPECT_NO_RENDERER_ERROR);
      }
    );
  });

  it("includes a production-build hint so operators know to rebuild", () => {
    expect(INSPECT_NO_DEVTOOLS_HOOK_ERROR).toMatch(/release/i);
    expect(INSPECT_NO_DEVTOOLS_HOOK_ERROR).toMatch(/development|dev/i);
  });
});
