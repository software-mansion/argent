import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import type { NetworkConditions } from "./network-conditions";
import { ShapedLink } from "./shaped-link";

const TUNNEL_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
const PROXY_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);
const HOP_BY_HOP_HEADERS = new Set([
  ...PROXY_HEADERS,
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface ShapingProxyOptions {
  resolveTarget(host: string, port: number): Promise<ProxyTarget | null>;
  /** Asked again whenever data moves, so an open connection follows the latest answer. */
  bypass(host: string, port: number): boolean;
}

export interface ShapingProxy {
  port: number;
  setConditions(conditions: NetworkConditions | null): void;
  close(): Promise<void>;
}

function parseAuthority(authority: string): ProxyTarget | null {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(authority);
  const port = Number(match?.[2]);
  return match && port <= 65535 ? { host: match[1]!, port } : null;
}

function httpTarget(url: URL | null): ProxyTarget | null {
  if (!url || url.protocol !== "http:") return null;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
}

export function requestLineTarget(line: string): ProxyTarget | null {
  const [method, target = ""] = line.split(" ");
  return method === "CONNECT" ? parseAuthority(target) : httpTarget(URL.parse(target));
}

function forwardedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name))
  );
}

function originRequestHead(req: http.IncomingMessage, path: string): string {
  const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (!PROXY_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/**
 * An HTTP proxy on the host's loopback that delays and rate limits every byte
 * between the device and the proxy, for plain requests, CONNECT tunnels and upgrades.
 */
export async function startShapingProxy(options: ShapingProxyOptions): Promise<ShapingProxy> {
  const link = new ShapedLink();
  const sockets = new Set<net.Socket>();
  const agent = new http.Agent({ keepAlive: true });

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const resolve = (target: ProxyTarget): Promise<ProxyTarget | null> =>
    options.resolveTarget(target.host, target.port).catch(() => null);

  const relayResponse = (upstream: http.ClientRequest, res: http.ServerResponse): void => {
    upstream.on("response", (response) => {
      try {
        const headers = forwardedHeaders(response.headers);
        res.writeHead(response.statusCode ?? 502, response.statusMessage, headers);
      } catch {
        res.destroy();
        return;
      }
      response.pipe(res);
      response.on("close", () => {
        if (!response.complete) res.destroy();
      });
    });
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
  };

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = URL.parse(req.url ?? "");
    const requested = httpTarget(url);
    if (!url || !requested) return void res.writeHead(400).end();
    const target = await resolve(requested);
    if (res.destroyed) return;
    if (!target) return void res.writeHead(502).end();
    const upstream = http.request({
      agent,
      host: target.host,
      port: target.port,
      method: req.method,
      path: pathOf(url),
      headers: forwardedHeaders(req.headers),
    });
    relayResponse(upstream, res);
    req.pipe(upstream);
  };

  const pipeToTarget = async (
    client: Duplex,
    requested: ProxyTarget,
    start: (upstream: net.Socket) => void
  ) => {
    let upstream: net.Socket | null = null;
    client.on("error", () => upstream?.destroy());
    const target = await resolve(requested);
    if (client.destroyed) return;
    if (!target) return void client.end(BAD_GATEWAY);
    const connection = net.connect(target.port, target.host);
    upstream = connection;
    track(connection);
    let established = false;
    connection.once("connect", () => {
      established = true;
      start(connection);
      connection.pipe(client);
      client.pipe(connection);
    });
    connection.on("error", () => {
      if (!established) client.end(BAD_GATEWAY);
    });
    connection.on("close", (hadError) => {
      if (hadError && established) client.destroy();
    });
  };

  const refuse = (client: Duplex, response: string): void => {
    client.on("error", () => client.destroy());
    client.end(response);
  };

  const onConnect = async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const requested = parseAuthority(req.url ?? "");
    if (!requested) return refuse(client, BAD_GATEWAY);
    await pipeToTarget(client, requested, (upstream) => {
      client.write(TUNNEL_ESTABLISHED);
      if (head.length > 0) upstream.write(head);
    });
  };

  const onUpgrade = async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const url = URL.parse(req.url ?? "");
    const requested = httpTarget(url);
    if (!url || !requested) return refuse(client, BAD_REQUEST);
    await pipeToTarget(client, requested, (upstream) => {
      upstream.write(originRequestHead(req, pathOf(url)));
      if (head.length > 0) upstream.write(head);
    });
  };

  const isBypassed = (requestLine: string): boolean => {
    const target = requestLineTarget(requestLine);
    return target !== null && options.bypass(target.host, target.port);
  };

  const server = http.createServer({ requestTimeout: 0 });
  server.on("request", (req, res) => void onRequest(req, res).catch(() => res.destroy()));
  server.on("connect", (req, client: Duplex, head: Buffer) => {
    void onConnect(req, client, head).catch(() => client.destroy());
  });
  server.on("upgrade", (req, client: Duplex, head: Buffer) => {
    void onUpgrade(req, client, head).catch(() => client.destroy());
  });

  const listener = net.createServer({ allowHalfOpen: true }, (socket) => {
    track(socket);
    server.emit("connection", link.attach(socket, isBypassed));
  });
  const port = await listen(listener);

  return {
    port,
    setConditions: (conditions) => link.setConditions(conditions),
    async close() {
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await new Promise<void>((done) => listener.close(() => done()));
      server.close();
    },
  };
}
