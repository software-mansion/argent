import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import {
  startShapingProxy,
  type ProxyTarget,
  type ShapingProxy,
} from "../src/utils/network-shaping-proxy";

const LATENCY_MS = 300;
const SLACK_MS = 60;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listenOrigin(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

function startOrigin(): Promise<number> {
  return listenOrigin(
    http.createServer((req, res) => {
      if (req.url === "/headers") return void res.end(JSON.stringify(req.headers));
      res.end("aaaa");
    })
  );
}

async function startUpgradeOrigin() {
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, socket: net.Socket) => {
    headers.push(req.headers);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return { port: await listenOrigin(server), headers };
}

async function startProxy(
  resolve: (host: string, port: number) => ProxyTarget | null = (host, port) => ({ host, port })
): Promise<ShapingProxy> {
  const proxy = await startShapingProxy({
    resolveTarget: async (host, port) => resolve(host, port),
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

function deviceAgent(): http.Agent {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(() => agent.destroy());
  return agent;
}

function viaProxy(
  proxy: ShapingProxy,
  url: string,
  options: { agent?: http.Agent; headers?: http.OutgoingHttpHeaders } = {}
): Promise<{ status: number; body: string; ms: number; headers: http.IncomingHttpHeaders }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, path: url, ...options });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          ms: performance.now() - started,
          headers: res.headers,
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function openTunnel(
  proxy: ShapingProxy,
  authority: string
): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: authority,
    });
    req.on("connect", (res, socket) => {
      cleanups.push(() => void socket.destroy());
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket }));
    req.on("error", reject);
    req.end();
  });
}

function roundTripThroughTunnel(socket: net.Socket, port: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve) => {
    socket.once("data", () => resolve(performance.now() - started));
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  });
}

async function rawDeviceSocket(proxy: ShapingProxy) {
  const socket = net.connect(proxy.port, "127.0.0.1");
  socket.on("error", () => {});
  cleanups.push(() => void socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  return { socket, text: () => received };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upgradeThroughProxy(proxy: ShapingProxy, port: number) {
  const { socket, text } = await rawDeviceSocket(proxy);
  socket.write(
    `GET http://127.0.0.1:${port}/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\nProxy-Connection: keep-alive\r\n\r\n"
  );
  await waitFor(() => text().includes("\r\n\r\n"));
  const status = text().split("\r\n")[0];
  const started = performance.now();
  socket.write("frame");
  await waitFor(() => text().endsWith("frame"));
  return { status, echoMs: performance.now() - started };
}

describe("the shaping proxy", () => {
  it("forwards plain requests and adds the latency to each on a kept-alive connection", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    const agent = deviceAgent();
    await viaProxy(proxy, `http://127.0.0.1:${origin}/warm`, { agent });

    const direct = await viaProxy(proxy, `http://127.0.0.1:${origin}/`, { agent });
    proxy.setConditions({ latencyMs: LATENCY_MS });
    const shaped = await viaProxy(proxy, `http://127.0.0.1:${origin}/`, { agent });

    expect(direct).toMatchObject({ status: 200, body: "aaaa" });
    expect(direct.ms).toBeLessThan(LATENCY_MS / 2);
    expect(shaped.ms).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(shaped.ms).toBeLessThan(LATENCY_MS * 2);
  });

  it("delays every round trip inside a CONNECT tunnel", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status, socket } = await openTunnel(proxy, `127.0.0.1:${origin}`);
    const first = await roundTripThroughTunnel(socket, origin);
    const second = await roundTripThroughTunnel(socket, origin);

    expect(status).toBe(200);
    expect(first).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(second).toBeGreaterThan(LATENCY_MS - SLACK_MS);
  });

  it("carries a WebSocket upgrade and its frames, shaped, without the proxy's headers", async () => {
    const origin = await startUpgradeOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status, echoMs } = await upgradeThroughProxy(proxy, origin.port);

    expect(status).toBe("HTTP/1.1 101 Switching Protocols");
    expect(echoMs).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(origin.headers[0]).toMatchObject({ upgrade: "websocket", connection: "Upgrade" });
    expect(origin.headers[0]).not.toHaveProperty("proxy-connection");
  });

  it("connects to the target the resolver names", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(() => ({ host: "127.0.0.1", port: origin }));

    const res = await viaProxy(proxy, "http://10.0.2.2:1/");

    expect(res).toMatchObject({ status: 200, body: "aaaa" });
  });

  it("answers 502 for a target the resolver cannot reach or that refuses the connection", async () => {
    const unreachable = await startProxy(() => null);
    const refusing = await startProxy(() => ({ host: "127.0.0.1", port: 1 }));
    const { socket, text } = await rawDeviceSocket(unreachable);

    const plain = await viaProxy(unreachable, "http://localhost:5000/");
    const tunnel = await openTunnel(unreachable, "localhost:5000");
    const refused = await openTunnel(refusing, "localhost:5000");
    socket.write(
      "GET http://localhost:5000/ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    );

    expect([plain.status, tunnel.status, refused.status]).toEqual([502, 502, 502]);
    await waitFor(() => text().startsWith("HTTP/1.1 502"));
  });

  it("drops the proxy's hop-by-hop headers before it forwards a request", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();

    const res = await viaProxy(proxy, `http://127.0.0.1:${origin}/headers`, {
      headers: { "proxy-connection": "keep-alive", "x-app": "1" },
    });

    const headers = JSON.parse(res.body) as Record<string, string>;
    expect(headers["x-app"]).toBe("1");
    expect(headers).not.toHaveProperty("proxy-connection");
  });

  it("drops the headers that a Connection header names, in both directions", async () => {
    const origin = await listenOrigin(
      http.createServer((req, res) => {
        res.setHeader("Connection", "X-Origin-Hop");
        res.setHeader("X-Origin-Hop", "1");
        res.setHeader("X-Origin-App", "1");
        res.end(JSON.stringify(req.headers));
      })
    );
    const proxy = await startProxy();

    const res = await viaProxy(proxy, `http://127.0.0.1:${origin}/`, {
      headers: { "connection": "keep-alive, X-Device-Hop", "x-device-hop": "1", "x-app": "1" },
    });

    const received = JSON.parse(res.body) as Record<string, string>;
    expect(received["x-app"]).toBe("1");
    expect(received).not.toHaveProperty("x-device-hop");
    expect(res.headers["x-origin-app"]).toBe("1");
    expect(res.headers).not.toHaveProperty("x-origin-hop");
  });

  it("passes on the origin's valid early hints before its response", async () => {
    const preloads = ["</style.css>; rel=preload; as=style", "</app.js>; rel=preload; as=script"];
    const origin = await listenOrigin(
      http.createServer((_req, res) => {
        res.socket?.write("HTTP/1.1 103 Early Hints\r\nLink: not-a-link\r\n\r\n");
        res.writeEarlyHints({ link: preloads });
        setTimeout(() => res.end("aaaa"), 50);
      })
    );
    const proxy = await startProxy();

    const events = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://127.0.0.1:${origin}/`,
      });
      req.on("information", (info) => seen.push(`${info.statusCode} ${info.headers.link}`));
      req.on("response", (res) => {
        seen.push(`${res.statusCode}`);
        res.resume();
        res.on("end", () => resolve(seen));
      });
      req.on("error", reject);
      req.end();
    });

    expect(events).toEqual([`103 ${preloads.join(", ")}`, "200"]);
  });

  it("stops the origin's request when the device gives up on it", async () => {
    let originClosed = false;
    const origin = await listenOrigin(
      http.createServer((_req, res) => {
        res.writeHead(200);
        res.write("first");
        res.on("close", () => (originClosed = true));
      })
    );
    const proxy = await startProxy();
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      path: `http://127.0.0.1:${origin}/stream`,
    });
    req.on("error", () => {});
    req.on("response", () => req.destroy());
    req.end();

    await waitFor(() => originClosed);
  });

  it("answers 400 to an upgrade without an http target", async () => {
    const proxy = await startProxy();
    const { socket, text } = await rawDeviceSocket(proxy);

    socket.write("GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");

    await waitFor(() => text().startsWith("HTTP/1.1 400"));
  });

  it("opens nothing for a tunnel the device resets before the target resolves", async () => {
    let originConnections = 0;
    const origin = await listenOrigin(net.createServer(() => originConnections++));
    const slowProxy = await startShapingProxy({
      resolveTarget: async (host, port) => {
        await sleep(300);
        return { host, port };
      },
    });
    cleanups.push(() => slowProxy.close());
    const { socket } = await rawDeviceSocket(slowProxy);

    socket.write(`CONNECT 127.0.0.1:${origin} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await sleep(100);
    socket.resetAndDestroy();
    await sleep(500);

    expect(originConnections).toBe(0);
  });

  it("keeps serving after a response it cannot forward and a refused tunnel the device resets", async () => {
    const malformed = await listenOrigin(
      net.createServer((socket) => socket.end("HTTP/1.1 000 Weird\r\nContent-Length: 0\r\n\r\n"))
    );
    const origin = await startOrigin();
    const proxy = await startProxy();
    const { socket } = await rawDeviceSocket(proxy);

    await expect(viaProxy(proxy, `http://127.0.0.1:${malformed}/`)).rejects.toThrow();
    socket.write("CONNECT no-port HTTP/1.1\r\nHost: x\r\n\r\n");
    socket.resetAndDestroy();
    await sleep(200);

    expect((await viaProxy(proxy, `http://127.0.0.1:${origin}/`)).status).toBe(200);
  });

  it("closes the device's connections when it closes", async () => {
    const origin = await startOrigin();
    const proxy = await startShapingProxy({
      resolveTarget: async (host, port) => ({ host, port }),
    });
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin}`);
    const closed = new Promise((resolve) => socket.once("close", resolve));

    await proxy.close();

    await expect(closed).resolves.toBeDefined();
  });
});
