import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import {
  LinkDirection,
  requestLineTarget,
  startShapingProxy,
  type ProxyTarget,
  type ShapingProxy,
} from "../src/utils/network-shaping-proxy";

const LATENCY_MS = 300;
/** Timers fire a little early or late; a delay counts when it lands within this margin. */
const SLACK_MS = 60;

interface Origin {
  port: number;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startOrigin(): Promise<Origin> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/headers") {
      res.end(JSON.stringify(req.headers));
      return;
    }
    const bytes = Number(url.searchParams.get("bytes") ?? 4);
    let received = 0;
    req.on("data", (chunk: Buffer) => (received += chunk.length));
    req.on("end", () => res.end(received > 0 ? String(received) : Buffer.alloc(bytes, 97)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  cleanups.push(() => {
    server.closeAllConnections();
    return origin.close();
  });
  return origin;
}

async function startProxy(
  resolve: (host: string, port: number) => ProxyTarget | null = (host, port) => ({ host, port }),
  bypass: (host: string, port: number) => boolean = () => false
): Promise<ShapingProxy> {
  const proxy = await startShapingProxy({
    resolveTarget: async (host, port) => resolve(host, port),
    bypass,
  });
  cleanups.push(() => proxy.close());
  return proxy;
}

/** A device-side client: one keep-alive connection to the proxy. */
function deviceAgent(): http.Agent {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(async () => agent.destroy());
  return agent;
}

function viaProxy(
  proxy: ShapingProxy,
  agent: http.Agent,
  url: string,
  body?: Buffer
): Promise<{ status: number; body: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      agent,
      host: "127.0.0.1",
      port: proxy.port,
      method: body ? "POST" : "GET",
      path: url,
    });
    req.on("response", (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: text, ms: performance.now() - started })
      );
    });
    req.on("error", reject);
    req.end(body);
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
    req.on("connect", (res, socket, head) => {
      cleanups.push(async () => void socket.destroy());
      if (head.length > 0) socket.unshift(head);
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket }));
    req.on("error", reject);
    req.end();
  });
}

/** A request over an established tunnel, timed from send to the first response byte. */
function roundTripThroughTunnel(socket: net.Socket, port: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve) => {
    socket.once("data", () => resolve(performance.now() - started));
    socket.write(`GET /?bytes=4 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  });
}

/** An origin that answers WebSocket-style upgrades and then echoes what it gets. */
async function startUpgradeOrigin(): Promise<Origin & { headers: http.IncomingHttpHeaders[] }> {
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
    headers.push(req.headers);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    if (head.length > 0) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return { ...(await listenOrigin(server)), headers };
}

/** An origin that writes `bytes` on every new connection and then ends it. */
async function startClosingOrigin(bytes: number): Promise<Origin> {
  const server = net.createServer((socket) => socket.end(Buffer.alloc(bytes, 97)));
  return listenOrigin(server);
}

async function listenOrigin(server: net.Server): Promise<Origin> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return origin.close();
  });
  return origin;
}

/** A raw device connection to the proxy, read as text. */
async function rawDeviceSocket(
  proxy: ShapingProxy
): Promise<{ socket: net.Socket; text: () => string }> {
  const socket = net.connect(proxy.port, "127.0.0.1");
  cleanups.push(async () => void socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  return { socket, text: () => received };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens a WebSocket-style upgrade through the proxy and times one echoed frame. */
async function upgradeThroughProxy(proxy: ShapingProxy, port: number) {
  const { socket, text } = await rawDeviceSocket(proxy);
  socket.write(
    `GET http://127.0.0.1:${port}/message HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\nProxy-Connection: keep-alive\r\n\r\n"
  );
  await waitFor(() => text().includes("\r\n\r\n"));
  const status = text().split("\r\n")[0];
  const started = performance.now();
  socket.write("frame");
  await waitFor(() => text().endsWith("frame"));
  return { status, echoMs: performance.now() - started };
}

/** Writes 1 MiB chunks as fast as the reader takes them; returns the bytes handed over so far. */
function floodWithBackpressure(socket: net.Socket | http.ServerResponse): () => number {
  const chunk = Buffer.alloc(1024 * 1024, 97);
  let written = 0;
  const writeMore = (): void => {
    let room = true;
    while (room && !socket.destroyed) {
      room = socket.write(chunk);
      written += chunk.length;
    }
    if (!socket.destroyed) socket.once("drain", writeMore);
  };
  writeMore();
  return () => written;
}

/** Far below what an unbounded proxy buffers in a second, far above the kernel's socket buffers. */
const BOUNDED_BYTES = 64 * 1024 * 1024;

describe("LinkDirection", () => {
  it("delays by half the latency, as each direction carries half a round trip", () => {
    const link = new LinkDirection();
    link.configure(undefined, 400);

    expect(link.send(1000, 0)).toEqual({ sentAt: 0, arrivesAt: 200 });
  });

  it("sends bytes back to back at the speed limit", () => {
    const link = new LinkDirection();
    link.configure(800, undefined);

    expect(link.send(1000, 0)).toEqual({ sentAt: 10, arrivesAt: 10 });
    expect(link.send(1000, 0)).toEqual({ sentAt: 20, arrivesAt: 20 });
  });

  it("lets a sender make up at most 20 ms of idle link", () => {
    const link = new LinkDirection();
    link.configure(800, undefined);
    link.send(1000, 0);

    expect(link.send(1000, 25)).toEqual({ sentAt: 20, arrivesAt: 25 });
    expect(link.send(1000, 100)).toEqual({ sentAt: 90, arrivesAt: 100 });
  });

  it("never delivers before the latency has passed", () => {
    const link = new LinkDirection();
    link.configure(800, 100);

    expect(link.send(1000, 100)).toEqual({ sentAt: 90, arrivesAt: 150 });
  });

  it("forgets the speed limit's backlog when the conditions change", () => {
    const link = new LinkDirection();
    link.configure(8, undefined);
    link.send(60_000, 0);

    link.configure(undefined, 100);

    expect(link.send(10, 1_000)).toEqual({ sentAt: 1_000, arrivesAt: 1_050 });
  });

  it("shapes nothing until configured", () => {
    const link = new LinkDirection();

    expect(link.shaping).toBe(false);
    link.configure(undefined, 1);
    expect(link.shaping).toBe(true);
    link.configure(undefined, undefined);
    expect(link.shaping).toBe(false);
  });
});

describe("requestLineTarget", () => {
  it.each([
    ["CONNECT example.com:443 HTTP/1.1", { host: "example.com", port: 443 }],
    ["CONNECT [::1]:8081 HTTP/1.1", { host: "::1", port: 8081 }],
    ["GET http://10.0.2.2:8081/index.bundle HTTP/1.1", { host: "10.0.2.2", port: 8081 }],
    ["POST http://example.com/ HTTP/1.1", { host: "example.com", port: 80 }],
    ["GET /index.bundle HTTP/1.1", null],
    ["CONNECT example.com HTTP/1.1", null],
    ["CONNECT example.com:99999 HTTP/1.1", null],
  ])("reads %j", (line, target) => {
    expect(requestLineTarget(line)).toEqual(target);
  });
});

describe("the shaping proxy", () => {
  it("forwards plain requests without conditions", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();

    const res = await viaProxy(proxy, deviceAgent(), `http://127.0.0.1:${origin.port}/?bytes=4`);

    expect(res).toMatchObject({ status: 200, body: "aaaa" });
  });

  it("adds the latency to every request on a kept-alive connection", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    const agent = deviceAgent();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const times: number[] = [];
    for (const path of ["a", "b", "c"]) {
      times.push((await viaProxy(proxy, agent, `http://127.0.0.1:${origin.port}/${path}`)).ms);
    }

    for (const ms of times) expect(ms).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    for (const ms of times) expect(ms).toBeLessThan(LATENCY_MS * 2);
  });

  it("applies new conditions to a connection that is already open", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    const agent = deviceAgent();
    await viaProxy(proxy, agent, `http://127.0.0.1:${origin.port}/warm`);

    proxy.setConditions({ latencyMs: LATENCY_MS });
    const shaped = await viaProxy(proxy, agent, `http://127.0.0.1:${origin.port}/shaped`);
    proxy.setConditions(null);
    const cleared = await viaProxy(proxy, agent, `http://127.0.0.1:${origin.port}/cleared`);

    expect(shaped.ms).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(cleared.ms).toBeLessThan(LATENCY_MS / 2);
  });

  it.each([
    { name: "a reset", next: null },
    { name: "faster conditions", next: { downloadKbps: 100_000 } },
  ])("frees a download that is mid-transfer at $name", async ({ next }) => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ downloadKbps: 8 });

    const download = viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=200000`
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const changed = performance.now();
    proxy.setConditions(next);

    expect((await download).body).toHaveLength(200_000);
    expect(performance.now() - changed).toBeLessThan(1_000);
  });

  it("holds a download that is mid-transfer to slower new conditions", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ downloadKbps: 100_000, latencyMs: 600 });

    const download = viaProxy(proxy, deviceAgent(), `http://127.0.0.1:${origin.port}/?bytes=50000`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const changed = performance.now();
    proxy.setConditions({ downloadKbps: 400 });

    expect((await download).body).toHaveLength(50_000);
    expect(performance.now() - changed).toBeGreaterThan(1_000 - SLACK_MS);
  });

  it("limits the download speed", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ downloadKbps: 1000 });

    const res = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=50000`
    );

    expect(res.body).toHaveLength(50_000);
    expect(res.ms).toBeGreaterThan(400 - SLACK_MS);
    expect(res.ms).toBeLessThan(400 * 2);
  });

  it("limits the upload speed", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ uploadKbps: 1000 });

    const res = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/up`,
      Buffer.alloc(50_000)
    );

    expect(res.body).toBe("50000");
    expect(res.ms).toBeGreaterThan(400 - SLACK_MS);
    expect(res.ms).toBeLessThan(400 * 2);
  });

  it("delays every round trip inside a CONNECT tunnel", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status, socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);
    const first = await roundTripThroughTunnel(socket, origin.port);
    const second = await roundTripThroughTunnel(socket, origin.port);

    expect(status).toBe(200);
    expect(first).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(second).toBeGreaterThan(LATENCY_MS - SLACK_MS);
  });

  it("connects to the target the resolver names", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(() => ({ host: "127.0.0.1", port: origin.port }));

    const res = await viaProxy(proxy, deviceAgent(), "http://10.0.2.2:1/?bytes=2");

    expect(res).toMatchObject({ status: 200, body: "aa" });
  });

  it("leaves a bypassed target unshaped, in plain requests and tunnels", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(undefined, (_host, port) => port === origin.port);
    proxy.setConditions({ latencyMs: LATENCY_MS, downloadKbps: 100 });

    const plain = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=20000`
    );
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);
    const tunneled = await roundTripThroughTunnel(socket, origin.port);

    expect(plain.body).toHaveLength(20_000);
    expect(plain.ms).toBeLessThan(LATENCY_MS / 2);
    expect(tunneled).toBeLessThan(LATENCY_MS / 2);
  });

  it("carries a WebSocket upgrade and its frames, shaped", async () => {
    const origin = await startUpgradeOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status, echoMs } = await upgradeThroughProxy(proxy, origin.port);

    expect(status).toBe("HTTP/1.1 101 Switching Protocols");
    expect(echoMs).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(origin.headers[0]).toMatchObject({ upgrade: "websocket", connection: "Upgrade" });
    expect(origin.headers[0]).not.toHaveProperty("proxy-connection");
  });

  it("leaves a bypassed WebSocket unshaped", async () => {
    const origin = await startUpgradeOrigin();
    const proxy = await startProxy(undefined, (_host, port) => port === origin.port);
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status, echoMs } = await upgradeThroughProxy(proxy, origin.port);

    expect(status).toBe("HTTP/1.1 101 Switching Protocols");
    expect(echoMs).toBeLessThan(LATENCY_MS / 2);
  });

  it("passes on data the device sent with the upgrade request", async () => {
    const origin = await startUpgradeOrigin();
    const proxy = await startProxy();
    const { socket, text } = await rawDeviceSocket(proxy);

    socket.write(
      `GET http://127.0.0.1:${origin.port}/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nearly`
    );

    await waitFor(() => text().endsWith("\r\n\r\nearly"));
  });

  it("answers 502 to an upgrade for a target it cannot reach", async () => {
    const proxy = await startProxy(() => null);
    const { socket, text } = await rawDeviceSocket(proxy);

    socket.write(
      "GET http://localhost:5000/hot HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    );

    await waitFor(() => text().startsWith("HTTP/1.1 502"));
  });

  it("delivers what a tunnel's origin sent before it closed", async () => {
    const origin = await startClosingOrigin(200_000);
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    let received = 0;
    socket.on("data", (chunk: Buffer) => (received += chunk.length));
    await new Promise((resolve) => socket.once("end", resolve));

    expect(received).toBe(200_000);
  });

  it("keeps a tunnel open for the answer after the device half-closes it", async () => {
    const origin = await listenOrigin(
      net.createServer({ allowHalfOpen: true }, (socket) => {
        let request = "";
        socket.on("data", (chunk: Buffer) => (request += chunk.toString()));
        socket.on("end", () => socket.end(`bye:${request}`));
      })
    );
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    let answer = "";
    socket.on("data", (chunk: Buffer) => (answer += chunk.toString()));
    socket.end("hello");
    await new Promise((resolve) => socket.once("end", resolve));

    expect(answer).toBe("bye:hello");
  });

  it("cuts the device's response when the origin fails partway", async () => {
    const origin = await listenOrigin(
      net.createServer((socket) => {
        socket.once("data", () => {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
          socket.write(Buffer.alloc(1_000, 97), () => socket.destroy());
        });
      })
    );
    const proxy = await startProxy();

    const outcome = await new Promise<string>((resolve) => {
      const req = http.request({
        agent: deviceAgent(),
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://127.0.0.1:${origin.port}/`,
      });
      req.on("response", (res) => {
        res.on("end", () => resolve("complete"));
        res.on("error", () => resolve("cut"));
        res.on("aborted", () => resolve("cut"));
        res.resume();
      });
      req.on("error", () => resolve("cut"));
      req.end();
    });

    expect(outcome).toBe("cut");
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
      agent: deviceAgent(),
      host: "127.0.0.1",
      port: proxy.port,
      path: `http://127.0.0.1:${origin.port}/stream`,
    });
    req.on("error", () => {});
    req.on("response", () => req.destroy());
    req.end();

    await waitFor(() => originClosed);
  });

  function slowProxy(port: number): Promise<ShapingProxy> {
    return startShapingProxy({
      resolveTarget: async (host) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { host, port };
      },
      bypass: () => false,
    }).then((proxy) => {
      cleanups.push(() => proxy.close());
      return proxy;
    });
  }

  it("closes the origin connection when the device resets an open tunnel", async () => {
    let originClosed = false;
    const origin = await listenOrigin(
      net.createServer((socket) => {
        socket.resume();
        socket.on("close", () => (originClosed = true));
      })
    );
    const proxy = await startProxy();
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    socket.resetAndDestroy();

    await waitFor(() => originClosed);
  });

  it("opens nothing for a tunnel the device resets before the target resolves", async () => {
    let originConnections = 0;
    const origin = await listenOrigin(net.createServer(() => originConnections++));
    const proxy = await slowProxy(origin.port);
    const { socket } = await rawDeviceSocket(proxy);

    socket.write(`CONNECT 127.0.0.1:${origin.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(originConnections).toBe(0);
  });

  it("passes on the device's half-close to a tunnel that opens after it", async () => {
    let opened = 0;
    let ended = 0;
    const origin = await listenOrigin(
      net.createServer({ allowHalfOpen: true }, (socket) => {
        opened++;
        socket.on("end", () => ended++);
      })
    );
    const proxy = await slowProxy(origin.port);
    const { socket } = await rawDeviceSocket(proxy);

    socket.write(`CONNECT 127.0.0.1:${origin.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.end();

    await waitFor(() => opened > 0 && ended === opened);
  });

  it("opens no origin connection for a request the device gave up on before the target resolved", async () => {
    let originConnections = 0;
    const server = http.createServer((_req, res) => res.end());
    server.on("connection", () => originConnections++);
    const origin = await listenOrigin(server);
    const proxy = await slowProxy(origin.port);
    const { socket } = await rawDeviceSocket(proxy);

    socket.write(`GET http://127.0.0.1:${origin.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(originConnections).toBe(0);
  });

  it("answers 502 to a shaped tunnel whose target refuses the connection", async () => {
    const closed = await listenOrigin(net.createServer());
    const refusedPort = closed.port;
    await closed.close();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: LATENCY_MS });

    const { status } = await openTunnel(proxy, `127.0.0.1:${refusedPort}`);

    expect(status).toBe(502);
  });

  it.each([
    ["without conditions", null],
    ["at latency", { latencyMs: 200 }],
  ])("stops reading the origin while the device does not read, %s", async (_label, conditions) => {
    let written = (): number => 0;
    const origin = await listenOrigin(
      http.createServer((_req, res) => {
        res.writeHead(200);
        written = floodWithBackpressure(res);
      })
    );
    const proxy = await startProxy();
    proxy.setConditions(conditions);
    const { socket } = await rawDeviceSocket(proxy);
    socket.once("data", () => socket.pause());

    socket.write(`GET http://127.0.0.1:${origin.port}/big HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(written()).toBeGreaterThan(0);
    expect(written()).toBeLessThan(BOUNDED_BYTES);
  });

  it.each([
    ["without conditions", null],
    ["with a download limit only", { downloadKbps: 1000 }],
    ["at latency", { latencyMs: 200 }],
  ])("stops reading the device while the origin does not read, %s", async (_label, conditions) => {
    const origin = await listenOrigin(net.createServer((socket) => socket.pause()));
    const proxy = await startProxy();
    proxy.setConditions(conditions);
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    const written = floodWithBackpressure(socket);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(written()).toBeGreaterThan(0);
    expect(written()).toBeLessThan(BOUNDED_BYTES);
  });

  it("carries a download larger than its queue at latency", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: 100 });

    const res = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=${12 * 1024 * 1024}`
    );

    expect(res.body).toHaveLength(12 * 1024 * 1024);
  });

  it("reads the device again once a slow origin catches up", async () => {
    const total = 24 * 1024 * 1024;
    let received = 0;
    const origin = await listenOrigin(
      net.createServer((socket) => {
        socket.pause();
        setTimeout(() => socket.resume(), 300);
        socket.on("data", (chunk: Buffer) => (received += chunk.length));
      })
    );
    const proxy = await startProxy();
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    socket.write(Buffer.alloc(total, 97));

    await waitFor(() => received === total, 10_000);
  });

  it("holds the device's upload to the upload speed", async () => {
    const total = 6 * 1024 * 1024;
    let received = 0;
    const origin = await listenOrigin(
      net.createServer((socket) => socket.on("data", (chunk: Buffer) => (received += chunk.length)))
    );
    const proxy = await startProxy();
    proxy.setConditions({ uploadKbps: 16_000 });
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);

    const receivedWhenWritten = await new Promise<number>((resolve) =>
      socket.write(Buffer.alloc(total, 97), () => resolve(received))
    );

    expect(receivedWhenWritten).toBeGreaterThan(total * 0.3);
  }, 15_000);

  it.each([5_000, 20_000])("downloads at %i kbps within 5 percent", async (kbps) => {
    const bytes = (kbps * 1000) / 8;
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ downloadKbps: kbps });

    const res = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=${bytes}`
    );

    expect(res.body).toHaveLength(bytes);
    expect(res.ms).toBeGreaterThan(1_000 * 0.95);
    expect(res.ms).toBeLessThan(1_000 * 1.05);
  });

  it("keeps a speed limit at high latency, whatever the queue holds", async () => {
    const bytes = 20 * 1024 * 1024;
    const origin = await startOrigin();
    const proxy = await startProxy();
    proxy.setConditions({ latencyMs: 3_000, downloadKbps: 80_000 });

    const res = await viaProxy(
      proxy,
      deviceAgent(),
      `http://127.0.0.1:${origin.port}/?bytes=${bytes}`
    );

    const expectedMs = 3_000 + (bytes * 8) / 80_000;
    expect(res.body).toHaveLength(bytes);
    expect(res.ms).toBeLessThan(expectedMs * 1.15);
  }, 15_000);

  it("bounds the queue of a huge speed limit at a long latency", async () => {
    let written = (): number => 0;
    const origin = await listenOrigin(
      net.createServer((socket) => {
        written = floodWithBackpressure(socket);
      })
    );
    const proxy = await startProxy();
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);
    socket.resume();

    proxy.setConditions({ latencyMs: 60_000, downloadKbps: 10_000_000 });
    const before = written();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(written() - before).toBeGreaterThan(0);
    expect(written() - before).toBeLessThan(2 * BOUNDED_BYTES);
  });

  it("drops the proxy's hop-by-hop headers before it forwards a request", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();

    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://127.0.0.1:${origin.port}/headers`,
        headers: { "proxy-connection": "keep-alive", "x-app": "1" },
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve(JSON.parse(text)));
      });
      req.on("error", reject);
      req.end();
    });

    expect(headers["x-app"]).toBe("1");
    expect(headers).not.toHaveProperty("proxy-connection");
  });

  it("answers 502 for a target it cannot reach", async () => {
    const proxy = await startProxy(() => null);

    const plain = await viaProxy(proxy, deviceAgent(), "http://localhost:5000/");
    const tunnel = await openTunnel(proxy, "localhost:5000");

    expect(plain.status).toBe(502);
    expect(tunnel.status).toBe(502);
  });

  it("drops a response whose status line it cannot forward and keeps serving", async () => {
    const malformed = await listenOrigin(
      net.createServer((socket) => socket.end("HTTP/1.1 000 Weird\r\nContent-Length: 0\r\n\r\n"))
    );
    const origin = await startOrigin();
    const proxy = await startProxy();

    await expect(
      viaProxy(proxy, deviceAgent(), `http://127.0.0.1:${malformed.port}/`)
    ).rejects.toThrow();
    const next = await viaProxy(proxy, deviceAgent(), `http://127.0.0.1:${origin.port}/`);

    expect(next.status).toBe(200);
  });

  it("survives a device that resets a tunnel request it refused", async () => {
    const proxy = await startProxy();
    const { socket } = await rawDeviceSocket(proxy);

    socket.write("CONNECT no-port HTTP/1.1\r\nHost: x\r\n\r\n");
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("closes the device's connections when it closes", async () => {
    const origin = await startOrigin();
    const proxy = await startShapingProxy({
      resolveTarget: async (host, port) => ({ host, port }),
      bypass: () => false,
    });
    const { socket } = await openTunnel(proxy, `127.0.0.1:${origin.port}`);
    const closed = new Promise((resolve) => socket.once("close", resolve));

    await proxy.close();

    await expect(closed).resolves.toBeDefined();
  });
});
