import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
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

describe("CDPClient executionContextCreated event", () => {
  it("emits typed executionContextCreated when Runtime.executionContextCreated arrives", async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connectPromise = client.connect();
    const ws = await waitForServer();
    await connectPromise;

    const received: Record<string, unknown>[] = [];
    client.events.on("executionContextCreated", (params) => {
      received.push(params);
    });

    const ctxPayload = {
      context: { id: 1, name: "main", origin: "" },
    };
    ws.send(
      JSON.stringify({
        method: "Runtime.executionContextCreated",
        params: ctxPayload,
      })
    );

    // Give the WS message a tick to be dispatched.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(ctxPayload);

    await client.disconnect();
  });

  it("still emits the generic event after executionContextCreated (no regression)", async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connectPromise = client.connect();
    const ws = await waitForServer();
    await connectPromise;

    const genericMethods: string[] = [];
    client.events.on("event", (method) => {
      genericMethods.push(method);
    });

    ws.send(
      JSON.stringify({
        method: "Runtime.executionContextCreated",
        params: { context: { id: 2 } },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(genericMethods).toContain("Runtime.executionContextCreated");

    await client.disconnect();
  });
});
