import { WebSocketServer } from "ws";
import * as http from "node:http";
import { AddressInfo } from "node:net";

/** A TCP port that (was just proven to be bindable and) now has no listener. */
export async function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface MockMetroCdp {
  port: number;
  close: () => Promise<void>;
}

/**
 * Mock Metro HTTP + CDP WebSocket target, the minimum wire behavior the
 * JsRuntimeDebugger connect pipeline needs (same protocol surface as
 * test/metro/integration.test.ts): /status, /json/list with one Fusebox
 * target, and a CDP socket that ACKs every method (Debugger.enable also emits
 * a scriptParsed; Runtime.evaluate answers a string so the addBinding probe
 * sees the binding as installed).
 */
export async function startMockMetroCdp(opts?: {
  /** Advertise this logicalDeviceId on the single target (default: none). */
  logicalDeviceId?: string;
}): Promise<MockMetroCdp> {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.setHeader("X-React-Native-Project-Root", "/mock/project");
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "page-1",
            title: "React Native (mock)",
            description: "[C++ connection]",
            webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=0&page=1`,
            deviceName: "MockDevice",
            reactNative: {
              capabilities: { prefersFuseboxFrontend: true },
              ...(opts?.logicalDeviceId ? { logicalDeviceId: opts.logicalDeviceId } : {}),
            },
          },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Debugger.enable") {
        ws.send(JSON.stringify({ id: msg.id, result: { debuggerId: "mock-debugger" } }));
        ws.send(
          JSON.stringify({
            method: "Debugger.scriptParsed",
            params: {
              scriptId: "1",
              url: "http://localhost/index.bundle?platform=ios&dev=true",
              startLine: 0,
              endLine: 50000,
            },
          })
        );
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        ws.send(
          JSON.stringify({ id: msg.id, result: { result: { type: "string", value: "mock" } } })
        );
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.close();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
