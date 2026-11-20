import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Session } from "node:inspector";
import { WebSocketServer } from "ws";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";

interface SentRequest {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Serves this process's own V8 over a WebSocket, so the scripts that
 * evaluateAwaited sends really run. `awaitPromise` is dropped on the way, so
 * V8 hands back a Promise handle the way Hermes does.
 */
let wss: WebSocketServer;
let session: Session;
let sent: SentRequest[];

function reply(id: number, error: Error | null, result: unknown): string {
  return JSON.stringify(
    error ? { id, error: { code: -32000, message: error.message } } : { id, result }
  );
}

beforeEach(async () => {
  sent = [];
  session = new Session();
  session.connect();
  wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const { id, method, params } = JSON.parse(raw.toString()) as SentRequest & { id: number };
      sent.push({ method, params });
      const hermesParams = { ...params, awaitPromise: false };
      session.post(method, hermesParams, (error, result) => ws.send(reply(id, error, result)));
    });
  });
});

afterEach(async () => {
  session.disconnect();
  await new Promise((resolve) => wss.close(resolve));
});

async function connect(options: { awaitPromisesInApp: boolean }): Promise<CDPClient> {
  const { port } = wss.address() as { port: number };
  const client = new CDPClient(`ws://localhost:${port}`, options);
  await client.connect();
  return client;
}

function leftoverSlots(): string[] {
  return Object.keys(globalThis).filter((key) => key.startsWith("__argentPromise_"));
}

function sentMethods(): string[] {
  return sent.map((request) => request.method);
}

describe("CDPClient.evaluateAwaited", () => {
  it("returns the value a Promise resolves to and removes its slot", async () => {
    const client = await connect({ awaitPromisesInApp: true });

    const value = await client.evaluateAwaited(
      "new Promise((resolve) => setTimeout(() => resolve({ n: 42 }), 150))"
    );

    expect(value).toEqual({ n: 42 });
    expect(leftoverSlots()).toEqual([]);
    await client.disconnect();
  });

  it("throws the rejection reason as a runtime exception", async () => {
    const client = await connect({ awaitPromisesInApp: true });

    const error = await client
      .evaluateAwaited(
        'new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 150))'
      )
      .catch((e: unknown) => e);

    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION);
    expect((error as Error).message).toContain("Error: boom");
    await client.disconnect();
  });

  it("keeps a rejection reason that is not an Error readable", async () => {
    const client = await connect({ awaitPromisesInApp: true });

    const error = await client
      .evaluateAwaited("new Promise((_, reject) => setTimeout(() => reject({ code: 7 }), 150))")
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('Promise rejected with: {"code":7}');
    await client.disconnect();
  });

  it("returns primitives and objects by value and releases the handle", async () => {
    const client = await connect({ awaitPromisesInApp: true });

    expect(await client.evaluateAwaited("1 + 1")).toBe(2);
    expect(await client.evaluateAwaited('"a" + "b"')).toBe("ab");
    expect(await client.evaluateAwaited('Symbol("s")')).toBeUndefined();
    expect(await client.evaluateAwaited("({ a: [1, 2] })")).toEqual({ a: [1, 2] });
    await vi.waitFor(() => expect(sentMethods()).toContain("Runtime.releaseObject"));
    await client.disconnect();
  });

  it("fails with DEBUGGER_CDP_REQUEST_TIMEOUT when the Promise never settles", async () => {
    const client = await connect({ awaitPromisesInApp: true });

    const error = await client
      .evaluateAwaited("new Promise(() => {})", { timeout: 300 })
      .catch((e: unknown) => e);

    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
    expect((error as Error).message).toContain("did not settle within 300ms");
    await vi.waitFor(() => expect(leftoverSlots()).toEqual([]));
    await client.disconnect();
  });

  it("sends one by-value evaluate as before when the client does not await in the app", async () => {
    const client = await connect({ awaitPromisesInApp: false });

    expect(await client.evaluateAwaited("({ n: 7 })")).toEqual({ n: 7 });
    expect(sent).toEqual([
      {
        method: "Runtime.evaluate",
        params: { expression: "({ n: 7 })", returnByValue: true, awaitPromise: true },
      },
    ]);
    await client.disconnect();
  });
});
