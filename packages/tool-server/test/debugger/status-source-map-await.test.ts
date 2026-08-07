import { describe, it, expect } from "vitest";
import { debuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";

/**
 * `debugger-status` promises in its own description that `sourceMapReady` is
 * "always true — waits for pending source maps before returning". The wait is the
 * whole content of that promise: `sourceMapReady` is a hardcoded literal, so a
 * status that returns *before* pending maps settle reports readiness it never
 * established. These tests pin the ordering, not the literal.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred;
  d.promise = new Promise<void>((res) => {
    d.resolve = () => {
      d.settled = true;
      res();
    };
  });
  return d;
}

function fakeApi(waitForPending: () => Promise<void>): JsRuntimeDebuggerApi {
  return {
    port: 8081,
    projectRoot: "/mock/project",
    deviceName: "MockDevice",
    appName: "MockApp",
    logicalDeviceId: "logical-1",
    isNewDebugger: true,
    cdp: {
      isConnected: () => true,
      getLoadedScripts: () => new Map([["1", {}]]),
      getEnabledDomains: () => new Set(["Runtime", "Debugger"]),
    },
    sourceMaps: { waitForPending },
  } as unknown as JsRuntimeDebuggerApi;
}

const PARAMS = { port: 8081, device_id: "mock-device" };

describe("debugger-status waits for pending source maps", () => {
  it("does not resolve until the pending source-map registration settles", async () => {
    const pending = deferred();
    const api = fakeApi(() => pending.promise);

    let returned = false;
    const call = debuggerStatusTool.execute({ debugger: api }, PARAMS).then((r) => {
      returned = true;
      return r;
    });

    // Ample opportunity for a non-awaiting implementation to have returned:
    // several macrotask turns, far more than the microtask drain a bare
    // `return {...}` (or an `await Promise.resolve()`) would need.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));

    expect(pending.settled).toBe(false);
    expect(returned).toBe(false);

    pending.resolve();
    const result = await call;

    expect(pending.settled).toBe(true);
    expect(returned).toBe(true);
    expect(result.sourceMapReady).toBe(true);
  });

  it("reports sourceMapReady only after the wait, so the flag is never ahead of the registry", async () => {
    const order: string[] = [];
    const api = fakeApi(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("maps-settled");
    });

    const result = await debuggerStatusTool.execute({ debugger: api }, PARAMS);
    order.push("status-returned");

    expect(order).toEqual(["maps-settled", "status-returned"]);
    expect(result.sourceMapReady).toBe(true);
  });
});
