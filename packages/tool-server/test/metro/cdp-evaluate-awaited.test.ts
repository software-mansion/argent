import { describe, it, expect, afterEach } from "vitest";
import { Session } from "node:inspector/promises";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";

/**
 * evaluateAwaited against this process's own V8 through `node:inspector`.
 * It never asks for `awaitPromise` (Hermes ignores it), so V8 takes the same
 * path a Hermes app does, with a real runtime behind it.
 */
const sessions: Session[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.disconnect();
  delete (globalThis as Record<string, unknown>).__wrs;
});

function v8Client(hooks?: { beforeSend?: (method: string, params: any) => Promise<void> }) {
  const session = new Session();
  session.connect();
  sessions.push(session);
  const client = new CDPClient("ws://localhost:1");
  const calls: string[] = [];
  const timeouts: number[] = [];
  (client as any).send = async (method: string, params: any = {}, timeout?: number) => {
    calls.push(method);
    if (timeout !== undefined) timeouts.push(timeout);
    await hooks?.beforeSend?.(method, params);
    try {
      return await session.post(method as any, params);
    } catch (err) {
      throw new FailureError((err as Error).message, {
        error_code: FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
        failure_stage: "debugger_cdp_protocol",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }
  };
  return { client, calls, timeouts, session };
}

const TRACK = "(globalThis.__wrs||(globalThis.__wrs=[])).push(new WeakRef(o));";

async function collected(session: Session): Promise<boolean[]> {
  await new Promise((r) => setTimeout(r, 0));
  await session.post("HeapProfiler.collectGarbage");
  const refs = (globalThis as unknown as { __wrs: WeakRef<object>[] }).__wrs;
  return refs.map((w) => w.deref() === undefined);
}

function signalOf(fn: () => Promise<unknown>) {
  return fn().then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => ({ err: err as Error, signal: getFailureSignal(err) })
  );
}

describe("CDPClient.evaluateAwaited", () => {
  it("returns a primitive in one round-trip", async () => {
    const { client, calls } = v8Client();
    expect(await client.evaluateAwaited("1+1")).toBe(2);
    expect(calls).toEqual(["Runtime.evaluate", "Runtime.releaseObjectGroup"]);
  });

  it("serializes an object and leaves nothing pinned", async () => {
    const { client, session } = v8Client();
    expect(
      await client.evaluateAwaited(`(()=>{const o={a:1,b:[2,3]};${TRACK}return o})()`)
    ).toEqual({ a: 1, b: [2, 3] });
    expect(await collected(session)).toEqual([true]);
  });

  it("returns what a Promise resolves to and leaves nothing pinned", async () => {
    const { client, session } = v8Client();
    const expr = `(()=>{const o={x:42};${TRACK}return new Promise(r=>setTimeout(()=>r(o),100))})()`;
    expect(await client.evaluateAwaited(expr)).toEqual({ x: 42 });
    expect(await collected(session)).toEqual([true]);
  });

  it("polls without compiling a script per poll", async () => {
    const { client, session } = v8Client();
    let parsed = 0;
    await session.post("Debugger.enable");
    session.on("Debugger.scriptParsed", () => parsed++);
    expect(await client.evaluateAwaited("new Promise(r=>setTimeout(()=>r(1),1000))")).toBe(1);
    await session.post("Debugger.disable");
    expect(parsed).toBeLessThan(6);
  });

  it("reports an Error rejection with its stack", async () => {
    const { client } = v8Client();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject(new Error('boom'))")
    );
    expect(err.message).toMatch(/^Promise rejected: Error: boom\n\s+at /);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
  });

  it("keeps a non-Error rejection reason readable", async () => {
    const { client } = v8Client();
    await expect(client.evaluateAwaited("Promise.reject({code:42})")).rejects.toThrow(
      'Promise rejected: {"code":42}'
    );
  });

  it("reports a null-prototype rejection at once instead of timing out", async () => {
    const { client } = v8Client();
    const t0 = Date.now();
    await expect(
      client.evaluateAwaited("Promise.reject(Object.create(null))", { timeout: 2000 })
    ).rejects.toThrow("Promise rejected: {}");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("treats a then() that throws as a rejection and leaves no global behind", async () => {
    const { client } = v8Client();
    const before = Object.keys(globalThis);
    await expect(client.evaluateAwaited("({then(){throw new Error('sync')}})")).rejects.toThrow(
      /Promise rejected: Error: sync/
    );
    expect(Object.keys(globalThis)).toEqual(before);
  });

  it("keeps nothing alive when a Promise settles after the timeout", async () => {
    const { client, session } = v8Client();
    const before = Object.keys(globalThis);
    const expr = `(()=>{const o={big:new Array(1e5).fill(1)};${TRACK}return new Promise(r=>setTimeout(()=>r(o),300))})()`;
    const { signal } = await signalOf(() => client.evaluateAwaited(expr, { timeout: 100 }));
    expect(signal?.error_kind).toBe("timeout");
    await new Promise((r) => setTimeout(r, 400));
    expect(await collected(session)).toEqual([true]);
    expect(Object.keys(globalThis).filter((k) => !before.includes(k))).toEqual(["__wrs"]);
  });

  it("fails fast when the Promise's handle goes away mid-wait", async () => {
    let group: string | undefined;
    const ref: { session?: Session } = {};
    const { client, session: s } = v8Client({
      beforeSend: async (method, params) => {
        if (method === "Runtime.evaluate") group ??= params.objectGroup;
        if (method === "Runtime.getProperties" && group) {
          await ref.session!.post("Runtime.releaseObjectGroup", { objectGroup: group });
        }
      },
    });
    ref.session = s;
    const t0 = Date.now();
    await expect(
      client.evaluateAwaited("new Promise(r=>setTimeout(r,5000))", { timeout: 3000 })
    ).rejects.toThrow(/Lost the Promise while waiting for it/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("reports an expression that throws", async () => {
    const { client } = v8Client();
    const { err, signal } = await signalOf(() => client.evaluateAwaited("throw new Error('x')"));
    expect(err.message).toMatch(/Error: x/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
  });

  it("returns an object whose then is not a function as is", async () => {
    const { client } = v8Client();
    expect(await client.evaluateAwaited("({then:5,a:1})")).toEqual({ then: 5, a: 1 });
  });

  it("follows a thenable that resolves with a Promise", async () => {
    const { client } = v8Client();
    expect(await client.evaluateAwaited("({then(r){r(Promise.resolve(42))}})")).toBe(42);
  });

  it("returns a Symbol as its description, also when a Promise resolves to one", async () => {
    const { client } = v8Client();
    expect(await client.evaluateAwaited("Symbol('x')")).toBe("Symbol(x)");
    expect(await client.evaluateAwaited("Promise.resolve(Symbol('y'))")).toBe("Symbol(y)");
  });

  it("releases the object group when the first request times out", async () => {
    const released: string[] = [];
    const { client, session } = v8Client({
      beforeSend: async (method, params) => {
        if (method === "Runtime.releaseObjectGroup") released.push(params.objectGroup);
        if (method === "Runtime.evaluate") {
          void session.post("Runtime.evaluate", params);
          throw new FailureError("timed out", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
            failure_stage: "debugger_cdp_send",
            failure_area: "tool_server",
            error_kind: "timeout",
          });
        }
      },
    });
    const { signal } = await signalOf(() =>
      client.evaluateAwaited(`(()=>{const o={big:new Array(1e5).fill(1)};${TRACK}return o})()`)
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
    expect(released).toHaveLength(1);
    expect(await collected(session)).toEqual([true]);
  });

  it("keeps the whole call within one timeout budget", async () => {
    const { client, timeouts } = v8Client({
      beforeSend: async (method) => {
        if (method === "Runtime.evaluate") await new Promise((r) => setTimeout(r, 300));
      },
    });
    const t0 = Date.now();
    const { signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(()=>{})", { timeout: 400 })
    );
    expect(signal?.error_kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(600);
    expect(Math.max(...timeouts.slice(1, -1))).toBeLessThanOrEqual(400 - 250);
  });

  it("reports a pause instead of waiting out the timeout", async () => {
    const { client } = v8Client({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") {
          (client as any).paused = { callFrames: [], reason: "other" };
        }
      },
    });
    const t0 = Date.now();
    const { signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(r=>setTimeout(r,5000))", { timeout: 3000 })
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.JS_RUNTIME_PAUSED);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not let the registry retry once the expression has run", async () => {
    const { client } = v8Client({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") {
          throw new FailureError("CDP not connected", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
            failure_stage: "debugger_cdp_send",
            failure_area: "tool_server",
            error_kind: "network",
          });
        }
      },
    });
    const { err } = await signalOf(() => client.evaluateAwaited("new Promise(()=>{})"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED);
    expect(jsRuntimeDebuggerBlueprint.recoverable?.(err)).toBe(false);
  });

  it("passes a request timeout while polling through unchanged", async () => {
    const { client } = v8Client({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") {
          throw new FailureError("timed out", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
            failure_stage: "debugger_cdp_send",
            failure_area: "tool_server",
            error_kind: "timeout",
          });
        }
      },
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("new Promise(()=>{})"));
    expect(err.message).toBe("timed out");
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
  });
});

describe("debugger-evaluate with a Promise that never settles", () => {
  it("reports a timeout, not an expression that threw", async () => {
    const { client } = v8Client();
    const services = {
      debugger: {
        cdp: {
          evaluateAwaited: (e: string) => client.evaluateAwaited(e, { timeout: 100 }),
        },
        deviceName: "MockDevice",
        appName: "MockApp",
        logicalDeviceId: "aaa",
      } as unknown as JsRuntimeDebuggerApi,
    };
    const { signal } = await signalOf(() =>
      debuggerEvaluateTool.execute(services, {
        port: 8081,
        device_id: "dev",
        expression: "new Promise(()=>{})",
      })
    );
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
      error_kind: "timeout",
    });
  });
});
