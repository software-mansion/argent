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

/**
 * Helper: set up the mock WS to reply with a given exceptionDetails payload
 * when it receives a Runtime.evaluate request.
 */
function replyWithException(ws: WebSocket, exceptionDetails: Record<string, unknown>) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "Runtime.evaluate") {
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { exceptionDetails },
        })
      );
    }
  });
}

describe("CDPClient.evaluate — formatExceptionDetails", () => {
  it("returns description as-is when it contains an embedded stack trace", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    const embeddedStack =
      "ReferenceError: foo is not defined\n    at render (http://localhost:8081/src/App.tsx:10:5)";
    replyWithException(ws, {
      exception: { description: embeddedStack },
    });

    await expect(client.evaluate("foo()")).rejects.toThrow(embeddedStack);
    await client.disconnect();
  });

  it("uses .text when .exception.description is absent", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    replyWithException(ws, {
      text: "Uncaught SyntaxError: Unexpected token",
    });

    await expect(client.evaluate("bad syntax")).rejects.toThrow(
      "Uncaught SyntaxError: Unexpected token"
    );
    await client.disconnect();
  });

  it("falls back to default message when both description and text are missing", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    replyWithException(ws, {
      exception: { value: null },
    });

    await expect(client.evaluate("null()")).rejects.toThrow(
      "Script evaluation threw an exception"
    );
    await client.disconnect();
  });

  it("appends formatted call frames when description has no embedded stack", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    replyWithException(ws, {
      exception: { description: "TypeError: x is not a function" },
      stackTrace: {
        callFrames: [
          {
            functionName: "handlePress",
            url: "http://localhost:8081/src/Button.tsx",
            lineNumber: 19,
            columnNumber: 4,
          },
          {
            functionName: "",
            url: "http://localhost:8081/src/App.tsx",
            lineNumber: 41,
            columnNumber: 0,
          },
        ],
      },
    });

    try {
      await client.evaluate("x()");
      expect.unreachable("Should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("TypeError: x is not a function");
      expect(msg).toContain("  at handlePress (http://localhost:8081/src/Button.tsx:20:5)");
      expect(msg).toContain("  at <anonymous> (http://localhost:8081/src/App.tsx:42:1)");
    }

    await client.disconnect();
  });

  it("returns description without frames when callFrames array is empty", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    replyWithException(ws, {
      exception: { description: "RangeError: Maximum call stack size exceeded" },
      stackTrace: { callFrames: [] },
    });

    await expect(client.evaluate("recurse()")).rejects.toThrow(
      "RangeError: Maximum call stack size exceeded"
    );
    await client.disconnect();
  });

  it("uses <anonymous> for missing function names and URLs in frames", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    const ws = await waitForServer();

    replyWithException(ws, {
      text: "Uncaught error",
      stackTrace: {
        callFrames: [
          {
            functionName: "",
            url: "",
            lineNumber: 0,
            columnNumber: 0,
          },
        ],
      },
    });

    try {
      await client.evaluate("anon()");
      expect.unreachable("Should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("Uncaught error");
      expect(msg).toContain("  at <anonymous> (<anonymous>:1:1)");
    }

    await client.disconnect();
  });
});
