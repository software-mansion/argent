import { afterEach, describe, expect, it } from "vitest";
import { makeComponentTreeScript } from "../../src/utils/debugger/scripts/component-tree";

/**
 * Regression for the component-tree error channel: every error path must deliver
 * its result through the `__argent_callback` binding, exactly like the success
 * path. The consumer (`evaluateWithBinding`) runs Runtime.evaluate WITHOUT
 * returnByValue/awaitPromise, so the IIFE's return value is discarded — an error
 * that is merely `return`ed never settles the promise and the tool hangs until
 * the 15s binding timeout. This test asserts the binding IS invoked on error.
 */
function run(opts: { hook: unknown }): string[] {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    hook: g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    cb: g.__argent_callback,
    r: g.__r,
  };
  const payloads: string[] = [];
  g.window = g;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  g.__r = function () {};
  g.__argent_callback = (p: string) => {
    payloads.push(p);
  };
  try {
    void (0, eval)(makeComponentTreeScript({ requestId: "t" }));
    return payloads;
  } finally {
    g.window = saved.window;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved.hook;
    g.__argent_callback = saved.cb;
    g.__r = saved.r;
  }
}

// The SUCCESS path fires __argent_callback ASYNCHRONOUSLY (after `await
// Promise.all(...)` on the host measurements), so the binding must stay installed
// across the await — the synchronous run() helper restores it in its finally
// before the callback lands and would drop it. Also injects a real __r so the
// Paper branch can resolve UIManager + Dimensions.
async function runToSuccess(opts: { hook: unknown; r: unknown }): Promise<string[]> {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    hook: g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    cb: g.__argent_callback,
    r: g.__r,
  };
  const payloads: string[] = [];
  g.window = g;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = opts.hook;
  g.__r = opts.r;
  const landed = new Promise<void>((resolve) => {
    g.__argent_callback = (p: string) => {
      payloads.push(p);
      resolve();
    };
  });
  try {
    void (0, eval)(makeComponentTreeScript({ requestId: "t" }));
    await Promise.race([landed, new Promise((r) => setTimeout(r, 2000))]);
    return payloads;
  } finally {
    g.window = saved.window;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved.hook;
    g.__argent_callback = saved.cb;
    g.__r = saved.r;
  }
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__argent_callback;
  delete g.__r;
});

describe("component-tree delivers errors via the binding channel", () => {
  it("invokes __argent_callback on the 'No DevTools hook' error path", async () => {
    const payloads = run({ hook: undefined });
    await new Promise((r) => setTimeout(r, 10));
    expect(payloads.length).toBeGreaterThan(0);
  });

  it("encodes the error so the tool surfaces it as parsed.error", async () => {
    const payloads = run({ hook: undefined });
    await new Promise((r) => setTimeout(r, 10));
    const outer = JSON.parse(payloads[0]!) as { requestId: string; result: string };
    expect(outer.requestId).toBe("t");
    const inner = JSON.parse(outer.result) as { error?: string };
    expect(inner.error).toBe("No DevTools hook");
  });

  it("invokes __argent_callback on the 'No fiber roots' error path", async () => {
    // Hook present but every renderer yields zero roots → 'No fiber roots'.
    const hook = { renderers: new Map(), getFiberRoots: () => new Set() };
    const payloads = run({ hook });
    await new Promise((r) => setTimeout(r, 10));
    expect(payloads.length).toBeGreaterThan(0);
    const inner = JSON.parse((JSON.parse(payloads[0]!) as { result: string }).result) as {
      error?: string;
    };
    expect(inner.error).toBe("No fiber roots");
  });

  it("invokes __argent_callback on the 'Could not find UIManager' error path", async () => {
    // Fiber roots present (passes the 'No fiber roots' guard), but the stub __r
    // (function(){} → undefined) never yields a module with .UIManager and Fabric
    // is absent → 'Could not find UIManager'. Fires synchronously, before the
    // measurement await, so the synchronous run() helper captures it.
    const hook = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: {} }]),
    };
    const payloads = run({ hook });
    await new Promise((r) => setTimeout(r, 10));
    expect(payloads.length).toBeGreaterThan(0);
    const inner = JSON.parse((JSON.parse(payloads[0]!) as { result: string }).result) as {
      error?: string;
    };
    expect(inner.error).toBe("Could not find UIManager");
  });

  it("delivers the SUCCESS result through the binding (parsed.error is undefined)", async () => {
    // Guards against a regression where the top-level try/catch redirects or
    // suppresses the happy-path callback. Minimal Paper fiber tree: one named
    // component whose host child carries a nativeTag that measureInWindow resolves.
    const hostFiber = {
      type: "RCTView",
      stateNode: { _nativeTag: 42 },
      child: null,
      sibling: null,
    };
    const buttonFiber = {
      type: { displayName: "MyButton" },
      memoizedProps: { testID: "btn" },
      child: hostFiber,
      sibling: null,
    };
    const root = { current: { child: buttonFiber, sibling: null } };
    const hook = { renderers: new Map([[1, {}]]), getFiberRoots: () => new Set([root]) };
    // __r(0) exposes UIManager (measure) + Dimensions (screen size); Fabric absent → Paper path.
    const moduleObj = {
      UIManager: {
        measureInWindow: (_tag: number, cb: (x: number, y: number, w: number, h: number) => void) =>
          cb(10, 20, 100, 50),
      },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
    };
    const r = (i: number) => (i === 0 ? moduleObj : undefined);

    const payloads = await runToSuccess({ hook, r });
    expect(payloads.length).toBeGreaterThan(0);
    const outer = JSON.parse(payloads[0]!) as { requestId: string; result: string };
    expect(outer.requestId).toBe("t");
    const inner = JSON.parse(outer.result) as {
      error?: string;
      screenW: number;
      screenH: number;
      components: Array<{ name: string; testID?: string; rect: unknown }>;
    };
    expect(inner.error).toBeUndefined();
    expect(inner.screenW).toBe(390);
    expect(inner.screenH).toBe(844);
    expect(inner.components.length).toBeGreaterThan(0);
    expect(inner.components[0]!.name).toBe("MyButton");
    expect(inner.components[0]!.testID).toBe("btn");
    expect(inner.components[0]!.rect).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it("routes an UNEXPECTED throw (outside the named guards) through the binding", async () => {
    // getFiberRoots throws on the legacy-roots path, which runs outside any inner
    // try/catch. Without the top-level try/catch the async IIFE would reject and
    // __argent_callback would never fire — the tool would hang to the 15s binding
    // timeout instead of surfacing the crash.
    const hook = {
      getFiberRoots: () => {
        throw new Error("boom");
      },
    };
    const payloads = run({ hook });
    await new Promise((r) => setTimeout(r, 10));
    expect(payloads.length).toBeGreaterThan(0);
    const inner = JSON.parse((JSON.parse(payloads[0]!) as { result: string }).result) as {
      error?: string;
    };
    expect(inner.error).toContain("Component-tree script crashed");
    expect(inner.error).toContain("boom");
  });

  it("delivers a crash that happens AFTER the measurement await through the still-installed binding", async () => {
    // Distinct from the synchronous crash above (getFiberRoots throws before any
    // await): here every guard passes and the throw happens in the post-await
    // continuation, after `await Promise.all(...)` on the host measurements. That
    // is the path closest to the production hang this change fixes — the failure
    // has to travel through the binding that is still installed across the await,
    // not be `return`ed. The fiber/module setup is the known-good success case,
    // except the kept component carries a BigInt accessibilityLabel (read without
    // a typeof guard), which the post-await `JSON.stringify(result)` cannot
    // serialize, forcing a genuine async throw into the top-level catch.
    //
    // Mutation-checked: ending the try before the await, or dropping the async
    // delivery, leaves the async IIFE to reject with the binding never firing —
    // `runToSuccess` then times out with zero payloads and this test fails, while
    // the synchronous crash test above (captured by the sync `run()` helper) stays
    // green. That is exactly the ~15s binding-timeout regression this guards.
    const hostFiber = {
      type: "RCTView",
      stateNode: { _nativeTag: 42 },
      child: null,
      sibling: null,
    };
    const buttonFiber = {
      type: { displayName: "MyButton" },
      memoizedProps: { testID: "btn", accessibilityLabel: BigInt(1) },
      child: hostFiber,
      sibling: null,
    };
    const root = { current: { child: buttonFiber, sibling: null } };
    const hook = { renderers: new Map([[1, {}]]), getFiberRoots: () => new Set([root]) };
    const moduleObj = {
      UIManager: {
        measureInWindow: (_tag: number, cb: (x: number, y: number, w: number, h: number) => void) =>
          cb(10, 20, 100, 50),
      },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
    };
    const r = (i: number) => (i === 0 ? moduleObj : undefined);

    const payloads = await runToSuccess({ hook, r });
    expect(payloads.length).toBeGreaterThan(0);
    const outer = JSON.parse(payloads[0]!) as { requestId: string; result: string };
    expect(outer.requestId).toBe("t");
    const inner = JSON.parse(outer.result) as { error?: string };
    expect(inner.error).toContain("Component-tree script crashed");
  });
});
