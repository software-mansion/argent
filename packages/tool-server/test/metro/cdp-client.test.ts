import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";

let wss: WebSocketServer;
let port: number;
let serverWs: WebSocket | null = null;

beforeEach(async () => {
  serverWs = null;
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      port = (wss.address() as { port: number }).port;
      resolve();
    });
  });
  wss.on("connection", (ws) => {
    serverWs = ws;
  });
});

afterEach(async () => {
  if (serverWs) serverWs.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

function waitForServer(): Promise<WebSocket> {
  return new Promise((resolve) => {
    if (serverWs) return resolve(serverWs);
    wss.once("connection", (ws) => resolve(ws));
  });
}

describe("CDPClient", () => {
  it("connects and disconnects", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("sends a command and receives response", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { debuggerId: "test-id" },
        })
      );
    });

    const result = await client.send("Runtime.enable");
    expect(result).toEqual({ debuggerId: "test-id" });
    expect(client.getEnabledDomains().has("Runtime")).toBe(true);
    await client.disconnect();
  });

  it("tracks enabled domains", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });

    await client.send("Debugger.enable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(true);

    await client.send("Debugger.disable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(false);

    await client.disconnect();
  });

  it("accumulates scriptParsed events", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "42",
            url: "http://localhost:8081/index.bundle",
            startLine: 0,
            endLine: 9999,
          },
        })
      );
    });

    await client.send("Debugger.enable");
    await new Promise((r) => setTimeout(r, 50));

    const scripts = client.getLoadedScripts();
    expect(scripts.has("42")).toBe(true);
    expect(scripts.get("42")!.url).toContain("index.bundle");

    await client.disconnect();
  });

  it("handles CDP errors", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        })
      );
    });

    await expect(client.send("Nonexistent.method")).rejects.toThrow("Method not found");
    await client.disconnect();
  });

  it("emits disconnected on server close", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const disconnected = new Promise<void>((resolve) => {
      client.events.on("disconnected", () => resolve());
    });

    const ws = await waitForServer();
    ws.close();

    await disconnected;
    expect(client.isConnected()).toBe(false);
  });

  it("evaluateWithBinding matches by requestId", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({
                  requestId: "req-123",
                  type: "inspect_result",
                  data: "test",
                }),
              },
            })
          );
        }, 10);
      }
    });

    const result = await client.evaluateWithBinding("someScript()", "req-123", { timeout: 5000 });

    expect(result.requestId).toBe("req-123");
    expect(result.type).toBe("inspect_result");
    expect(result.data).toBe("test");

    await client.disconnect();
  });

  it("evaluate requests returnByValue + awaitPromise and returns object results", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        // A returnByValue response carries the deep-serialized value. Without
        // returnByValue, Hermes/V8 return a RemoteObject ref with no `value`,
        // which is exactly the dropped-object bug this guards against.
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: "object", value: { a: 1, b: [2, 3] } } },
          })
        );
      }
    });

    const value = await client.evaluate("({ a: 1, b: [2, 3] })");

    expect(evalParams?.returnByValue).toBe(true);
    expect(evalParams?.awaitPromise).toBe(true);
    expect(value).toEqual({ a: 1, b: [2, 3] });

    await client.disconnect();
  });

  it("evaluateWithBinding drives the script with returnByValue + awaitPromise off", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({ requestId: "req-1", data: "x" }),
              },
            })
          );
        }, 10);
      }
    });

    await client.evaluateWithBinding("someScript()", "req-1", { timeout: 5000 });

    // The binding delivers the payload; the script's own return must not be
    // serialized or awaited, or fire-and-forget binding scripts would hang.
    expect(evalParams?.returnByValue).toBe(false);
    expect(evalParams?.awaitPromise).toBe(false);

    await client.disconnect();
  });

  // Failure-signal classification: each CDP transport fault must carry its own
  // precise code instead of surfacing as an unclassified plain Error (which
  // telemetry buckets under REGISTRY_SERVICE_INITIALIZATION_FAILED / unknown).
  describe("failure signal classification", () => {
    async function rejection(p: Promise<unknown>): Promise<unknown> {
      try {
        await p;
      } catch (err) {
        return err;
      }
      throw new Error("expected the promise to reject");
    }

    it("send before connect rejects with DEBUGGER_CDP_NOT_CONNECTED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      // never connect()ed
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP not connected");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
        failure_stage: "debugger_cdp_send",
        error_kind: "network",
      });
    });

    it("an unanswered request rejects with DEBUGGER_CDP_REQUEST_TIMEOUT", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      // The server never replies — the per-request timer must fire.
      const err = await rejection(client.send("Runtime.enable", {}, 50));
      expect((err as Error).message).toMatch(/CDP request Runtime\.enable \(id=\d+\) timed out/);
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
        failure_stage: "debugger_cdp_send",
        error_kind: "timeout",
      });
      await client.disconnect();
    });

    it("server close mid-request rejects the pending send with DEBUGGER_CDP_CONNECTION_CLOSED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      const ws = await waitForServer();
      ws.on("message", () => ws.close());
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP connection closed");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
        failure_stage: "debugger_cdp_lifecycle",
        error_kind: "network",
      });
    });

    it("connect to a dead port rejects with a classified connect-stage code", async () => {
      // Grab a port nothing listens on: bind an ephemeral server, then close it.
      const deadPort = await new Promise<number>((resolve) => {
        const probe = new WebSocketServer({ port: 0 }, () => {
          const p = (probe.address() as { port: number }).port;
          probe.close(() => resolve(p));
        });
      });
      const client = new CDPClient(`ws://localhost:${deadPort}`);
      const err = await rejection(client.connect());
      const signal = getFailureSignal(err);
      // ECONNREFUSED surfaces via the error handler (CONNECT_FAILED); some
      // stacks deliver only a close (SOCKET_CLOSED_BEFORE_OPEN). Either way the
      // stage must be the connect stage and the kind network.
      expect([
        FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
        FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN,
      ]).toContain(signal?.error_code);
      expect(signal).toMatchObject({
        failure_stage: "debugger_cdp_connect",
        error_kind: "network",
      });
    });
  });
});
