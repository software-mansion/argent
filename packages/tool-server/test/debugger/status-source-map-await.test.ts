import { describe, it, expect, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";

// The tool resolves its api through the registry, so the fake is handed over
// there rather than injected as a service.
const resolved = vi.hoisted(() => ({ api: undefined as JsRuntimeDebuggerApi | undefined }));
vi.mock("../../src/tools/debugger/not-connected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/debugger/not-connected")>()),
  resolveDebuggerService: () => Promise.resolve(resolved.api),
}));

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

type StatusResult = Awaited<ReturnType<typeof statusTool.execute>>;

function assertConnected(
  result: StatusResult
): asserts result is Extract<StatusResult, { status: "connected" }> {
  expect(result.status).toBe("connected");
}

// Only the stale-connection branch reaches the registry, and `isConnected` is
// true throughout, so no member of it is ever read here.
const statusTool = createDebuggerStatusTool({} as Registry);

describe("debugger-status waits for pending source maps", () => {
  it("does not resolve until the pending source-map registration settles", async () => {
    const pending = deferred();
    resolved.api = fakeApi(() => pending.promise);

    let returned = false;
    const call = statusTool.execute({}, PARAMS, undefined).then((r) => {
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
    assertConnected(result);
    expect(result.sourceMapReady).toBe(true);
  });

  it("reports sourceMapReady only after the wait, so the flag is never ahead of the registry", async () => {
    const order: string[] = [];
    resolved.api = fakeApi(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("maps-settled");
    });

    const result = await statusTool.execute({}, PARAMS, undefined);
    order.push("status-returned");

    expect(order).toEqual(["maps-settled", "status-returned"]);
    assertConnected(result);
    expect(result.sourceMapReady).toBe(true);
  });
});
