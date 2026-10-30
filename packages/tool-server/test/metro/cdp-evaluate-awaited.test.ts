import { describe, it, expect, afterEach } from "vitest";
import { Session } from "node:inspector/promises";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";
import { formatErrorForAgent } from "../../src/utils/format-error";

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
  delete (globalThis as Record<string, unknown>).__n;
});

const PROBE = "Runtime.releaseObjectGroup";

interface Hooks {
  beforeSend?: (method: string, params: any, timeout?: number) => Promise<void>;
  /** Replaces the answer when it returns one. */
  answer?: (method: string, params: any) => unknown;
}

function protocolError(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
    failure_stage: "debugger_cdp_protocol",
    failure_area: "tool_server",
    error_kind: "unknown",
  });
}

function timedOut(): FailureError {
  return new FailureError("CDP request timed out — the runtime may be frozen", {
    error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    failure_stage: "debugger_cdp_send",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}

function makeClient(
  honoursAwaitPromise: boolean,
  hooks?: Hooks,
  options?: ConstructorParameters<typeof CDPClient>[1]
) {
  const session = new Session();
  session.connect();
  sessions.push(session);
  const client = new CDPClient("ws://localhost:1", options);
  const calls: string[] = [];
  const sent: { method: string; params: any; timeout?: number; answer?: any }[] = [];
  (client as any).send = async (method: string, params: any = {}, timeout?: number) => {
    calls.push(method);
    const record: (typeof sent)[number] = { method, params, timeout };
    sent.push(record);
    if (!honoursAwaitPromise && method === "Runtime.evaluate") {
      const { awaitPromise: _ignored, ...rest } = params;
      params = rest;
    }
    await hooks?.beforeSend?.(method, params, timeout);
    const replaced = hooks?.answer?.(method, params);
    if (replaced !== undefined) return replaced;
    try {
      record.answer = await session.post(method as any, params);
      return record.answer;
    } catch (err) {
      throw protocolError((err as Error).message);
    }
  };
  return { client, calls, sent, session };
}

/** Like the real send(): an answer slower than the request's timeout times out. */
async function answerAfter(ms: number, timeout?: number): Promise<void> {
  await new Promise((r) => setTimeout(r, Math.min(ms, timeout ?? ms)));
  if (timeout !== undefined && timeout < ms) throw timedOut();
}

function contextCreated(client: CDPClient): void {
  (client as any).handleMessage(
    Buffer.from(JSON.stringify({ method: "Runtime.executionContextCreated", params: {} }))
  );
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
const RESULT_LATE = /^The expression's result did not arrive within \d+ms\./;
const NO_ANSWER = /^The runtime did not answer the expression within \d+ms, nor a check/;
const PAUSE_HINT = "If another debugger has the runtime paused at a breakpoint, resume it there.";
const LOST = /^The expression ran, but reading its result failed: /;

describe("CDPClient.evaluateAwaited on a runtime that ignores awaitPromise", () => {
  it("returns a primitive in one round-trip once release support is known", async () => {
    const { client, calls } = hermesClient();
    expect(await client.evaluateAwaited("1+1")).toBe(2);
    expect(await client.evaluateAwaited("2+2")).toBe(4);
    expect(calls).toEqual([
      PROBE,
      "Runtime.evaluate",
      "Runtime.releaseObjectGroup",
      "Runtime.evaluate",
      "Runtime.releaseObjectGroup",
    ]);
  });

  it("reads a non-thenable object by value, and leaves nothing pinned", async () => {
    const { client, calls, sent, session } = hermesClient();
    expect(
      await client.evaluateAwaited(`(()=>{const o={a:1,b:[2,3]};${TRACK}return o})()`)
    ).toEqual({ a: 1, b: [2, 3] });
    expect(calls).toEqual([
      PROBE,
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.callFunctionOn",
      "Runtime.releaseObjectGroup",
    ]);
    const read = sent.filter((s) => s.method === "Runtime.callFunctionOn")[1]!;
    expect(read.params.returnByValue).toBe(true);
    expect(read.answer.result.value).toEqual({ value: { a: 1, b: [2, 3] } });
    expect(await collected(session)).toEqual([true]);
  });

  it("puts every handle it asks for in the call's object group", async () => {
    const { client, sent } = hermesClient();
    expect(await client.evaluateAwaited("new Promise(r=>setTimeout(()=>r(1),100))")).toBe(1);
    const group = sent.find((s) => s.method === "Runtime.evaluate")?.params.objectGroup;
    const calls = sent.filter((s) => s.method === "Runtime.callFunctionOn");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.params.objectGroup).toBe(group);
  });

  it("returns what a Promise resolves to and leaves nothing pinned", async () => {
    const { client, sent, session } = hermesClient();
    const expr = `(()=>{const o={x:42};${TRACK}return new Promise(r=>setTimeout(()=>r(o),100))})()`;
    expect(await client.evaluateAwaited(expr)).toEqual({ x: 42 });
    expect(await collected(session)).toEqual([true]);
    const read = sent.filter((s) => s.method === "Runtime.callFunctionOn").at(-1)!;
    expect(read.answer.result.value).toEqual({ value: { x: 42 } });
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

  it("keeps every field of a reason that only has a message, without calling it an Error", async () => {
    const { client } = hermesClient();
    const { err } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject({message:'bad',code:42,details:{field:'email'}})")
    );
    expect(err.message).toBe(
      'Promise rejected: {"message":"bad","code":42,"details":{"field":"email"}}'
    );
  });

  it("appends an Error's own fields to its stack, as native module rejections carry them", async () => {
    const { client } = hermesClient();
    const { err } = await signalOf(() =>
      client.evaluateAwaited(
        "Promise.reject(Object.assign(new Error('Permission denied'),{code:'E_PERMISSION'}))"
      )
    );
    expect(err.message).toMatch(/^Promise rejected: Error: Permission denied\n\s+at /);
    expect(err.message).toMatch(/\n\{"code":"E_PERMISSION"\}$/);
  });

  it("renders a reason with an empty stack or name from what is left", async () => {
    const { client } = hermesClient();
    const reject = (setup: string) =>
      signalOf(() =>
        client.evaluateAwaited(`(()=>{const e=new Error('m');${setup};return Promise.reject(e)})()`)
      ).then(({ err }) => err.message);
    expect(await reject("e.stack=''")).toBe("Promise rejected: Error: m");
    expect(await reject("e.stack='';e.name=''")).toBe("Promise rejected: m");
  });

  it("falls back past throwing getters on the reason", async () => {
    const { client } = hermesClient();
    await expect(
      client.evaluateAwaited(
        "Promise.reject(Object.create(Error.prototype,{stack:{get(){throw 1}},message:{value:'m'}}))"
      )
    ).rejects.toThrow("Promise rejected: Error: m");
    await expect(
      client.evaluateAwaited("Promise.reject({name:'X',get message(){throw 1}})")
    ).rejects.toThrow("Promise rejected: [object Object]");
  });

  it("renders a reason JSON cannot carry with String()", async () => {
    const { client } = hermesClient();
    const { err: fn } = await signalOf(() => client.evaluateAwaited("Promise.reject(()=>1)"));
    expect(fn.message).toBe("Promise rejected: ()=>1");
    const { err: big } = await signalOf(() => client.evaluateAwaited("Promise.reject(10n)"));
    expect(big.message).toBe("Promise rejected: 10");
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

  it("still reports a rejection whose reason is a revoked Proxy or has a throwing trap", async () => {
    const { client } = hermesClient();
    for (const reason of [
      "(()=>{const p=Proxy.revocable({},{});p.revoke();return p.proxy})()",
      "new Proxy({},{get(){throw new Error('trap')}})",
    ]) {
      const { err, signal } = await signalOf(() =>
        client.evaluateAwaited(`Promise.reject(${reason})`)
      );
      expect(err.message).toBe("Promise rejected: a reason that could not be read");
      expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    }
  });

  it("does not repeat a reason's stack among its other fields", async () => {
    const { client } = hermesClient();
    const { err } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject({stack:'s',code:1})")
    );
    expect(err.message).toBe('Promise rejected: s\n{"code":1}');
  });

  it("keeps an Error's stack when its other fields cannot be serialized", async () => {
    const { client } = hermesClient();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject(Object.assign(new Error('x'),{n:10n}))")
    );
    expect(err.message).toMatch(/^Promise rejected: Error: x\n\s+at /);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
  });

  it("reports a value whose serialization error cannot be stringified as unserializable", async () => {
    const { client } = hermesClient();
    const value = "({toJSON(){throw Object.create(null)}})";
    for (const expr of [value, `Promise.resolve(${value})`]) {
      const { err, signal } = await signalOf(() => client.evaluateAwaited(expr));
      expect(err.message).toBe(
        "The expression's result could not be serialized: the value could not be serialized"
      );
      expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    }
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

  it("reads then once", async () => {
    const { client } = hermesClient();
    expect(
      await client.evaluateAwaited(
        "globalThis.__n=0,({get then(){globalThis.__n++;return r=>r(5)}})"
      )
    ).toBe(5);
    expect((globalThis as Record<string, unknown>).__n).toBe(1);
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
    const expr = `(()=>{const o={big:new Array(1e5).fill(1)};${TRACK}return new Promise(r=>setTimeout(()=>r(o),800))})()`;
    const { signal } = await signalOf(() => client.evaluateAwaited(expr, { timeout: 100 }));
    expect(signal?.error_kind).toBe("timeout");
    await new Promise((r) => setTimeout(r, 300));
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
    ).rejects.toThrow(LOST);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("says the expression ran when the handle goes away before the watch or the value read", async () => {
    for (const lostAt of [1, 2]) {
      let group: string | undefined;
      let helperCalls = 0;
      const ref: { session?: Session } = {};
      const { client, session } = hermesClient({
        beforeSend: async (method, params) => {
          if (method === "Runtime.evaluate") group ??= params.objectGroup;
          if (method === "Runtime.callFunctionOn" && ++helperCalls === lostAt) {
            await ref.session!.post("Runtime.releaseObjectGroup", { objectGroup: group });
          }
        },
      });
      ref.session = session;
      const { err, signal } = await signalOf(() => client.evaluateAwaited("Promise.resolve(1)"));
      expect(err.message).toMatch(LOST);
      expect(err.message).toMatch(/Do not run the expression again for its side effects\./);
      expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR);
    }
  });

  it("says the expression ran when the connection closes while its result is read", async () => {
    const { client } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.callFunctionOn") {
          throw new FailureError("CDP connection closed", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
            failure_stage: "debugger_cdp_lifecycle",
            failure_area: "tool_server",
            error_kind: "network",
          });
        }
      },
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("Promise.resolve(1)"));
    expect(err.message).toBe(
      "The connection closed after the expression ran, before its result was read."
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED);
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

  it("returns what a bare NaN, Infinity or -0 returns when a Promise resolves to one", async () => {
    const { client } = hermesClient();
    for (const n of ["NaN", "Infinity", "-0"]) {
      expect(await client.evaluateAwaited(n)).toBeUndefined();
      expect(await client.evaluateAwaited(`Promise.resolve(${n})`)).toBeUndefined();
    }
  });

  it("reports a result JSON cannot serialize as the expression's error", async () => {
    const { client } = hermesClient();
    for (const expr of [
      "(()=>{const o={a:1};o.self=o;return o})()",
      "({a:10n})",
      "({toJSON(){throw new Error('nope')}})",
      "(()=>{const o={a:1};o.self=o;return Promise.resolve(o)})()",
    ]) {
      const { err, signal } = await signalOf(() => client.evaluateAwaited(expr));
      expect(err.message).toMatch(/^The expression's result could not be serialized: /);
      expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    }
  });

  it("reports a result nested deeper than the runtime's serializer allows as unserializable", async () => {
    const LIMIT = 6;
    const stringify = JSON.stringify;
    const depth = (v: unknown): number =>
      v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0;
    const nested = (n: number): unknown => (n === 0 ? 1 : { n: nested(n - 1) });
    const chain = (n: number) => `(${stringify(nested(n))})`;
    const { client } = hermesClient();
    JSON.stringify = ((value: unknown, replacer?: never, space?: never) => {
      if (depth(value) > LIMIT) throw new RangeError("Maximum nesting level exceeded");
      return stringify(value, replacer, space);
    }) as typeof JSON.stringify;
    try {
      expect(await client.evaluateAwaited(chain(LIMIT - 1))).toEqual(nested(LIMIT - 1));
      for (const expr of [chain(LIMIT), `Promise.resolve(${chain(LIMIT)})`]) {
        const { err } = await signalOf(() => client.evaluateAwaited(expr));
        expect(err.message).toBe(
          "The expression's result could not be serialized: RangeError: Maximum nesting level exceeded"
        );
      }
    } finally {
      JSON.stringify = stringify;
    }
  });

  it("names the runtime's reason when a result is too deep to send by value", async () => {
    const deep = "(()=>{let l=null;for(let i=0;i<1500;i++)l={v:i,next:l};return l})()";
    for (const makeClientFor of [hermesClient, v8Client]) {
      const { client } = makeClientFor();
      for (const expr of [deep, `Promise.resolve(${deep})`]) {
        const { err, signal } = await signalOf(() => client.evaluateAwaited(expr));
        expect(err.message).toMatch(LOST);
        expect(err.message).not.toMatch(/reading its result failed: \./);
        expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR);
      }
    }
  });

  it("refuses a function result instead of returning null for it", async () => {
    const { client } = hermesClient();
    for (const expr of [
      "(function foo(){return 5})",
      "Promise.resolve(()=>1)",
      "new Proxy(function(){},{})",
      "Promise.resolve(new Proxy(function(){},{}))",
    ]) {
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
    expect(released.filter((g) => g.startsWith("argent-await-"))).toHaveLength(1);
    expect(await collected(session)).toEqual([true]);
  });

  it("gives the expression the whole timeout and stops waiting at the deadline", async () => {
    const { client, sent } = hermesClient({
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
    expect(Date.now() - t0).toBeLessThan(1100);
    expect(sent.find((s) => s.method === "Runtime.evaluate")?.timeout).toBeGreaterThan(400);
  });

  it("releases the object group again when the first answer lands after the timeout", async () => {
    const released: string[] = [];
    const { client, session } = hermesClient({
      beforeSend: async (method, params, timeout) => {
        if (method === "Runtime.releaseObjectGroup") released.push(params.objectGroup);
        if (method === "Runtime.evaluate" && params.expression !== "0") {
          await answerAfter(300, timeout);
        }
      },
    });
    const { signal } = await signalOf(() =>
      client.evaluateAwaited(`(()=>{const o={big:new Array(1e5).fill(1)};${TRACK}return o})()`, {
        timeout: 100,
      })
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
    await new Promise((r) => setTimeout(r, 400));
    expect(released.filter((g) => g.startsWith("argent-await-"))).toHaveLength(2);
    expect(await collected(session)).toEqual([true]);
  });

  it("still reads a Promise whose callbacks run after the deadline passed", async () => {
    const { client } = hermesClient();
    expect(
      await client.evaluateAwaited(
        "(()=>{const t=Date.now();while(Date.now()-t<350);return {then(r){setTimeout(()=>r(1),100)}}})()",
        { timeout: 300 }
      )
    ).toBe(1);
  });

  it("still reads a Promise that settled while the expression used up the budget", async () => {
    // Like the real send(): a request whose timeout is shorter than the round
    // trip times out.
    const LATENCY_MS = 50;
    const { client } = hermesClient({
      beforeSend: async (method, _params, timeout) => {
        if (method === "Runtime.evaluate" || method === PROBE) return;
        await new Promise((r) => setTimeout(r, LATENCY_MS));
        if (timeout !== undefined && timeout < LATENCY_MS) throw timedOut();
      },
    });
    expect(
      await client.evaluateAwaited(
        "(()=>{const t=Date.now();while(Date.now()-t<350);return Promise.resolve(1)})()",
        { timeout: 300 }
      )
    ).toBe(1);
  });

  it("reports a pause mid-wait as one after the expression ran, not as a retry", async () => {
    const { client } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") {
          (client as any).paused = {
            callFrames: [
              { url: "http://localhost:8081/index.bundle", location: { lineNumber: 2 } },
            ],
            reason: "exception",
          };
        }
      },
    });
    const t0 = Date.now();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(r=>setTimeout(r,5000))", { timeout: 3000 })
    );
    expect(signal?.error_code).toBe(FAILURE_CODES.JS_RUNTIME_PAUSED);
    expect(err.message).toMatch(
      /The expression ran, but the JS runtime paused on an exception at \S*index\.bundle:3 /
    );
    expect(formatErrorForAgent(err)).not.toMatch(/retry/);
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

  it("waits out a slow poll answer without sending anything else meanwhile", async () => {
    const { client, sent } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.getProperties") await new Promise((r) => setTimeout(r, 1500));
      },
    });
    expect(await client.evaluateAwaited("Promise.resolve(1)", { timeout: 5000 })).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(sent.filter((s) => s.params.expression === "0")).toEqual([]);
  });

  it("reports a poll slower than its read grace as unsettled, after the grace", async () => {
    const { client } = hermesClient({
      beforeSend: async (method, _params, timeout) => {
        if (method === "Runtime.getProperties") await answerAfter(3000, timeout);
      },
    });
    const t0 = Date.now();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("new Promise(()=>{})", { timeout: 300 })
    );
    expect(err.message).toMatch(UNSETTLED);
    expect(err.message).toContain(PAUSE_HINT);
    expect(signal?.error_kind).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t0).toBeLessThan(2800);
  });

  it("reports a read that times out after the expression ran as such, not as a frozen runtime", async () => {
    const { client } = hermesClient({
      beforeSend: async (method) => {
        if (method === "Runtime.callFunctionOn") throw timedOut();
      },
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("Promise.resolve(1)"));
    expect(err.message).toMatch(RESULT_LATE);
    expect(err.message).toContain(PAUSE_HINT);
    expect(err.message).not.toMatch(/frozen/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
  });

  it("falls back to evaluating by value, asking once, when handles cannot be released", async () => {
    const { client, calls } = hermesClient({
      beforeSend: async (method) => {
        if (method === PROBE)
          throw protocolError("Unsupported method 'Runtime.releaseObjectGroup'");
      },
    });
    expect(await client.evaluateAwaited("({a:1})")).toEqual({ a: 1 });
    expect(await client.evaluateAwaited("({b:2})")).toEqual({ b: 2 });
    expect(calls).toEqual([PROBE, "Runtime.evaluate", "Runtime.evaluate"]);
  });

  it("asks nothing and evaluates by value on the legacy inspector", async () => {
    const { client, calls } = makeClient(false, undefined, { releasesHandles: false });
    expect(await client.evaluateAwaited("({a:1})")).toEqual({ a: 1 });
    expect(calls).toEqual(["Runtime.evaluate"]);
  });

  it("fails before sending the expression when the release probe gets no answer, and asks again", async () => {
    let first = true;
    const { client, sent } = hermesClient({
      beforeSend: async (method) => {
        if (method === PROBE && first) {
          first = false;
          throw timedOut();
        }
      },
    });
    const { signal } = await signalOf(() => client.evaluateAwaited("1"));
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
    expect(sent.map((s) => s.method)).toEqual([PROBE]);
    expect(await client.evaluateAwaited("2")).toBe(2);
    expect(sent.filter((s) => s.params.objectGroup === "argent-release-probe")).toHaveLength(2);
  });

  it("waits for a slow release probe instead of assuming release works", async () => {
    const { client, calls } = hermesClient({
      beforeSend: async (method, _params, timeout) => {
        if (method !== PROBE) return;
        await answerAfter(1500, timeout);
        throw protocolError("Unsupported method 'Runtime.releaseObjectGroup'");
      },
    });
    expect(await client.evaluateAwaited("({a:1})", { timeout: 5000 })).toEqual({ a: 1 });
    expect(calls).toEqual([PROBE, "Runtime.evaluate"]);
  });

  it("asks about release support again once a new execution context is created", async () => {
    let first = true;
    const { client, calls } = hermesClient({
      beforeSend: async (method) => {
        if (method === PROBE && first) {
          first = false;
          throw protocolError("Unsupported method 'Runtime.releaseObjectGroup'");
        }
      },
    });
    expect(await client.evaluateAwaited("Promise.resolve(42)")).toEqual({});
    expect(await client.evaluateAwaited("Promise.resolve(42)")).toEqual({});
    contextCreated(client);
    expect(await client.evaluateAwaited("Promise.resolve(42)")).toBe(42);
    expect(calls.slice(0, 4)).toEqual([PROBE, "Runtime.evaluate", "Runtime.evaluate", PROBE]);
  });

  it("keeps evaluating by value on the legacy inspector after a new execution context", async () => {
    const { client, calls } = makeClient(false, undefined, { releasesHandles: false });
    contextCreated(client);
    expect(await client.evaluateAwaited("({a:1})")).toEqual({ a: 1 });
    expect(calls).toEqual(["Runtime.evaluate"]);
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
    expect(calls).toEqual([PROBE, "Runtime.evaluate", "Runtime.releaseObjectGroup"]);
  });

  it("reports a Promise still pending at the timeout as a timeout after the expression ran", async () => {
    const { client } = v8Client({
      beforeSend: async (method, params) => {
        if (method === "Runtime.evaluate" && params.expression !== "0") throw timedOut();
      },
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("new Promise(()=>{})"));
    expect(err.message).toMatch(RESULT_LATE);
    expect(err.message).toContain(PAUSE_HINT);
    expect(formatErrorForAgent(err)).not.toMatch(/retry/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
  });

  it("gives the check after a timeout a second to answer", async () => {
    const { client, sent } = v8Client({
      beforeSend: async (method, params, timeout) => {
        if (method !== "Runtime.evaluate") return;
        if (params.expression === "0") await answerAfter(300, timeout);
        else throw timedOut();
      },
    });
    const { err } = await signalOf(() => client.evaluateAwaited("new Promise(()=>{})"));
    expect(err.message).toMatch(RESULT_LATE);
    expect(sent.find((s) => s.params.expression === "0")?.timeout).toBe(1000);
  });

  it("says the runtime may be frozen or still running, without a retry, when nothing answers", async () => {
    const { client } = v8Client({
      beforeSend: async (method) => {
        if (method === "Runtime.evaluate") throw timedOut();
      },
    });
    const { err, signal } = await signalOf(() => client.evaluateAwaited("1"));
    expect(err.message).toMatch(NO_ANSWER);
    expect(err.message).toMatch(/still be running the expression, be frozen/);
    expect(err.message).toContain(PAUSE_HINT);
    expect(formatErrorForAgent(err)).not.toMatch(/retry/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
  });

  it("reports a rejection as the expression's error", async () => {
    const { client, calls } = v8Client();
    const { err, signal } = await signalOf(() =>
      client.evaluateAwaited("Promise.reject(new Error('x'))")
    );
    expect(err.message).toMatch(/Error: x/);
    expect(signal?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    expect(calls).toEqual([PROBE, "Runtime.evaluate", "Runtime.releaseObjectGroup"]);
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
