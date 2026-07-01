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
});
