import { describe, it, expect, afterEach } from "vitest";
import { Session } from "node:inspector/promises";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";

/**
 * evaluateAwaited against this process's own V8 through `node:inspector`.
 *
 * `hermesClient` drops `awaitPromise` from the first request, as Hermes
 * ignores it, so V8 takes the watch-and-poll path a Hermes app does, with a
 * real runtime behind it. `v8Client` keeps the flag, as Chromium honours it.
 */
const sessions: Session[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.disconnect();
  delete (globalThis as Record<string, unknown>).__wrs;
});

interface Hooks {
  beforeSend?: (method: string, params: any, timeout?: number) => Promise<void>;
  /** Replaces the answer when it returns one. */
  answer?: (method: string, params: any) => unknown;
}

function timedOut(): FailureError {
  return new FailureError("CDP request timed out — the runtime may be frozen", {
    error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    failure_stage: "debugger_cdp_send",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}

function makeClient(honoursAwaitPromise: boolean, hooks?: Hooks) {
  const session = new Session();
  session.connect();
  sessions.push(session);
  const client = new CDPClient("ws://localhost:1");
  const calls: string[] = [];
  const timeouts: number[] = [];
  (client as any).send = async (method: string, params: any = {}, timeout?: number) => {
    calls.push(method);
    if (timeout !== undefined) timeouts.push(timeout);
    if (!honoursAwaitPromise && method === "Runtime.evaluate") {
      const { awaitPromise: _ignored, ...rest } = params;
      params = rest;
    }
    await hooks?.beforeSend?.(method, params, timeout);
    const replaced = hooks?.answer?.(method, params);
    if (replaced !== undefined) return replaced;
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

const hermesClient = (hooks?: Hooks) => makeClient(false, hooks);
const v8Client = (hooks?: Hooks) => makeClient(true, hooks);

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

const UNSETTLED =
  /^The expression ran, but the Promise it returned did not settle within (\d+)ms\./;

describe("CDPClient.evaluateAwaited on a runtime that ignores awaitPromise", () => {
  it("returns a primitive in one round-trip", async () => {
    const { client, calls } = hermesClient();
    expect(await client.evaluateAwaited("1+1")).toBe(2);
    expect(calls).toEqual(["Runtime.evaluate", "Runtime.releaseObjectGroup"]);
  });

  it("serializes a non-thenable object without watching it, and leaves nothing pinned", async () => {
    const { client, calls, session } = hermesClient();
    expect(
      await client.evaluateAwaited(`(()=>{const o={a:1,b:[2,3]};${TRACK}return o})()`)
    ).toEqual({ a: 1, b: [2, 3] });
    expect(calls).toEqual([
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.releaseObjectGroup",
    ]);
    expect(await collected(session)).toEqual([true]);
  });

  it("returns what a Promise resolves to and leaves nothing pinned", async () => {
    const { client, session } = hermesClient();
    const expr = `(()=>{const o={x:42};${TRACK}return new Promise(r=>setTimeout(()=>r(o),100))})()`;
    expect(await client.evaluateAwaited(expr)).toEqual({ x: 42 });
    expect(await collected(session)).toEqual([true]);
  });

  it("polls at the poll interval, without compiling a script per poll", async () => {
    const { client, calls, session } = hermesClient();
    let parsed = 0;
    await session.post("Debugger.enable");
    session.on("Debugger.scriptParsed", () => parsed++);
    expect(await client.evaluateAwaited("new Promise(r=>setTimeout(()=>r(1),300))")).toBe(1);
    await session.post("Debugger.disable");
    expect(parsed).toBeLessThan(6);
    const polls = calls.filter((m) => m === "Runtime.getProperties").length;
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(polls).toBeLessThanOrEqual(12);
  });

  it("reports an Error rejection with its stack", async () => {
    const { client } = hermesClient();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject(new Error('boom'))")
    );
    expect(err.message).toMatch(/^Promise rejected: Error: boom\n\s+at /);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
  });

  it("reports an Error without a stack, and a DOMException-like reason, as name: message", async () => {
    const { client } = hermesClient();
    await expect(
      client.evaluateAwaited(
        "(()=>{const e=new Error('nostack');delete e.stack;return Promise.reject(e)})()"
      )
    ).rejects.toThrow("Promise rejected: Error: nostack");
    await expect(
      client.evaluateAwaited(
        "Promise.reject(Object.create({get name(){return 'AbortError'},get message(){return 'aborted'}}))"
      )
    ).rejects.toThrow("Promise rejected: AbortError: aborted");
  });

  it("keeps a non-Error rejection reason readable", async () => {
    const { client } = hermesClient();
    await expect(client.evaluateAwaited("Promise.reject({code:42})")).rejects.toThrow(
      'Promise rejected: {"code":42}'
    );
  });

  it("reports a null-prototype rejection at once instead of timing out", async () => {
    const { client } = hermesClient();
    const t0 = Date.now();
    await expect(
      client.evaluateAwaited("Promise.reject(Object.create(null))", { timeout: 2000 })
    ).rejects.toThrow("Promise rejected: {}");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("falls back to String() and then to Object.prototype.toString for a cyclic reason", async () => {
    const { client } = hermesClient();
    await expect(
      client.evaluateAwaited("(()=>{const o={};o.self=o;return Promise.reject(o)})()")
    ).rejects.toThrow("Promise rejected: [object Object]");
    await expect(
      client.evaluateAwaited(
        "(()=>{const o=Object.create(null);o.self=o;return Promise.reject(o)})()"
      )
    ).rejects.toThrow("Promise rejected: [object Object]");
  });

  it("treats a then() that throws as a rejection and leaves no global behind", async () => {
    const { client } = hermesClient();
    const before = Object.keys(globalThis);
    await expect(client.evaluateAwaited("({then(){throw new Error('sync')}})")).rejects.toThrow(
      /Promise rejected: Error: sync/
    );
    expect(Object.keys(globalThis)).toEqual(before);
  });

  it("treats a Promise whose own then throws synchronously as a rejection", async () => {
    const { client } = hermesClient();
    await expect(
      client.evaluateAwaited(
        "(()=>{const p=Promise.resolve(1);p.then=()=>{throw new Error('own then')};return p})()"
      )
    ).rejects.toThrow(/Promise rejected: Error: own then/);
  });

  it("treats a throwing then getter as a rejection", async () => {
    const { client } = hermesClient();
    await expect(
      client.evaluateAwaited("({get then(){throw new Error('getter')}})")
    ).rejects.toThrow(/Promise rejected: Error: getter/);
  });

  it("keeps nothing alive when a Promise settles after the timeout", async () => {
    const { client, session } = hermesClient();
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
    const { client, session: s } = hermesClient({
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
    const { client } = hermesClient();
    const { err, signal } = await signalOf(() => client.evaluateAwaited("throw new Error('x')"));
    expect(err.message).toMatch(/Error: x/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
  });

  it("returns an object whose then is not a function as is", async () => {
    const { client } = hermesClient();
    expect(await client.evaluateAwaited("({then:5,a:1})")).toEqual({ then: 5, a: 1 });
  });

  it("follows a thenable that resolves with a Promise", async () => {
    const { client } = hermesClient();
    expect(await client.evaluateAwaited("({then(r){r(Promise.resolve(42))}})")).toBe(42);
  });

  it("returns a Symbol as its description, also when a Promise resolves to one", async () => {
    const { client } = hermesClient();
    expect(await client.evaluateAwaited("Symbol('x')")).toBe("Symbol(x)");
    expect(await client.evaluateAwaited("Promise.resolve(Symbol('y'))")).toBe("Symbol(y)");
  });

  it("refuses a function result instead of returning null for it", async () => {
    const { client } = hermesClient();
    for (const expr of ["(function foo(){return 5})", "Promise.resolve(()=>1)"]) {
      const { err, signal } = await signalOf(() => client.evaluateAwaited(expr));
      expect(err.message).toMatch(/result is a function, which has no JSON form/);
      expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR);
      expect(signal?.error_kind).toBe("validation");
    }
  });

  it("releases the object group when the first request times out", async () => {
    const released: string[] = [];
    const { client, session } = hermesClient({
      beforeSend: async (method, params) => {
        if (method === "Runtime.releaseObjectGroup") released.push(params.objectGroup);
        if (method === "Runtime.evaluate") {
          void session.post("Runtime.evaluate", params);
          throw timedOut();
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

  it("gives the expression the whole timeout and stops waiting at the deadline", async () => {
    const { client, timeouts } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.evaluate") await new Promise((r) => setTimeout(r, 300));
      },
    });
    const t0 = Date.now();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(()=>{})", { timeout: 400 })
    );
    expect(signal?.error_kind).toBe("timeout");
    expect(err.message).toMatch(UNSETTLED);
    expect(Date.now() - t0).toBeLessThan(700);
    expect(timeouts[0]).toBe(400);
  });

  it("still reads a Promise that settled while the expression used up the budget", async () => {
    const { client } = hermesClient();
    expect(
      await client.evaluateAwaited(
        "(()=>{const t=Date.now();while(Date.now()-t<250);return Promise.resolve(1)})()",
        { timeout: 300 }
      )
    ).toBe(1);
  });

  it("reports a pause mid-wait as one after the expression ran, not as a retry", async () => {
    const { client } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") {
          (client as any).paused = { callFrames: [], reason: "other" };
        }
      },
    });
    const t0 = Date.now();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(r=>setTimeout(r,5000))", { timeout: 3000 })
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.JS_RUNTIME_PAUSED);
    expect(err.message).toMatch(/The expression ran, but the JS runtime paused/);
    expect(err.message).not.toMatch(/retry/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not let the registry retry once the expression has run", async () => {
    const { client } = hermesClient({
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

  it("does not blame the expression for a helper the inspector failed to run", async () => {
    const { client } = hermesClient({
      answer: (method) =>
        method === "Runtime.callFunctionOn"
          ? { exceptionDetails: { text: "Can't evalInFrame: Environment not found" } }
          : undefined,
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("Promise.resolve(1)"));
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR);
    expect(err.message).toMatch(/after the expression ran/);
    expect(err.message).toMatch(/Environment not found/);
  });

  it("nudges a stalled poll with an evaluate instead of giving up on it", async () => {
    // The legacy Hermes inspector can leave getProperties queued until an
    // evaluate wakes the runtime. Polls stall here until a nudge is seen.
    let nudged = false;
    const { client } = hermesClient({
      beforeSend: async (method, params) => {
        if (method === "Runtime.evaluate" && params.expression === "0") nudged = true;
        if (method === "Runtime.getProperties" && !nudged) throw timedOut();
      },
    });
    const t0 = Date.now();
    expect(
      await client.evaluateAwaited("new Promise(r=>setTimeout(()=>r(42),100))", { timeout: 5000 })
    ).toBe(42);
    expect(nudged).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("reports 'did not settle', not a frozen runtime, when polls run out of budget", async () => {
    // Like the real send(): a request whose timeout is shorter than the round
    // trip rejects with the generic "may be frozen" guidance.
    const LATENCY_MS = 20;
    const { client } = hermesClient({
      beforeSend: async (_method, _params, timeout) => {
        await new Promise((r) => setTimeout(r, LATENCY_MS));
        if (timeout !== undefined && timeout < LATENCY_MS) throw timedOut();
      },
    });
    for (const timeout of [300, 317, 334]) {
      const { err, signal } = await signalOf(() =>
        client.evaluateAwaited("new Promise(()=>{})", { timeout })
      );
      expect(err.message).toMatch(UNSETTLED);
      expect(err.message).toContain(`${timeout}ms`);
      expect(signal?.error_kind).toBe("timeout");
    }
  });
});

describe("CDPClient.evaluateAwaited on a runtime that honours awaitPromise", () => {
  it("settles inside the engine, with no watch or poll", async () => {
    const { client, calls } = v8Client();
    expect(await client.evaluateAwaited("new Promise(r=>setTimeout(()=>r(7),50))")).toBe(7);
    expect(calls).toEqual(["Runtime.evaluate", "Runtime.releaseObjectGroup"]);
  });

  it("reports a rejection as the expression's error", async () => {
    const { client, calls } = v8Client();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject(new Error('x'))")
    );
    expect(err.message).toMatch(/Error: x/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    expect(calls).toEqual(["Runtime.evaluate", "Runtime.releaseObjectGroup"]);
  });
});

describe("debugger-evaluate with a Promise that never settles", () => {
  it("reports a timeout, not an expression that threw", async () => {
    const { client } = hermesClient();
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
