import * as http from "node:http";
import * as net from "node:net";
import { Duplex } from "node:stream";
import type { NetworkConditions } from "./network-conditions";

/** A slice this size takes 0.5 s at 256 kbps, so a slow link still delivers data steadily. */
const SLICE_BYTES = 16 * 1024;
/**
 * Bytes a connection holds in one direction before it stops reading from the
 * sender. A speed-limited queue holds about rate x latency / 2, so it gets a
 * higher ceiling; past it a huge rate at a long latency runs below its limit.
 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_LIMITED_QUEUED_BYTES = 64 * 1024 * 1024;
/** Idle link time a sender may catch up on, so the gaps between writes do not lower the rate. */
const SEND_CREDIT_MS = 20;
const TUNNEL_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
const PROXY_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
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
  /**
   * Where to connect for a host and port the device asked for, or `null` when
   * the proxy cannot reach it.
   */
  resolveTarget(host: string, port: number): Promise<ProxyTarget | null>;
  /**
   * Whether a connection to this host and port passes without shaping, such as
   * Metro's. The first request of a connection decides for the whole connection.
   */
  bypass(host: string, port: number): boolean;
}

export interface ShapingProxy {
  port: number;
  setConditions(conditions: NetworkConditions | null): void;
  close(): Promise<void>;
}

/** One direction of the link. Every connection shares it, so a speed limit caps their sum. */
export class LinkDirection {
  private freeAt = 0;
  private bytesPerMs: number | null = null;
  private delayMs = 0;

  configure(kbps: number | undefined, latencyMs: number | undefined): void {
    this.bytesPerMs = kbps === undefined ? null : kbps / 8;
    this.delayMs = (latencyMs ?? 0) / 2;
    this.freeAt = 0;
  }

  get shaping(): boolean {
    return this.bytesPerMs !== null || this.delayMs > 0;
  }

  get limited(): boolean {
    return this.bytesPerMs !== null;
  }

  /** When `bytes` handed to the link at `now` finish sending, and when they arrive. */
  send(bytes: number, now: number): { sentAt: number; arrivesAt: number } {
    if (this.bytesPerMs === null) {
      return { sentAt: now, arrivesAt: now + this.delayMs };
    }
    const start = Math.max(now - SEND_CREDIT_MS, this.freeAt);
    this.freeAt = start + bytes / this.bytesPerMs;
    return { sentAt: this.freeAt, arrivesAt: Math.max(this.freeAt, now) + this.delayMs };
  }
}

const UNSHAPED = new LinkDirection();

interface QueuedSlice {
  arrivesAt: number;
  chunk: Buffer;
}

function slicesOf(chunk: Buffer): Buffer[] {
  const slices = [chunk.subarray(0, SLICE_BYTES)];
  for (let offset = SLICE_BYTES; offset < chunk.length; offset += SLICE_BYTES) {
    slices.push(chunk.subarray(offset, offset + SLICE_BYTES));
  }
  return slices;
}

/**
 * Delivers chunks in order, each when the link says it arrives. `done` runs
 * once the chunk has been sent, so a writer waits for the speed limit but not
 * for the latency.
 */
class DelayedQueue {
  private slices: QueuedSlice[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly sendTimers = new Set<NodeJS.Timeout>();
  private lastArrival = 0;
  queuedBytes = 0;

  constructor(
    private readonly link: () => LinkDirection,
    private readonly deliver: (chunk: Buffer) => void,
    private readonly onDrain: () => void
  ) {}

  get empty(): boolean {
    return this.slices.length === 0;
  }

  push(chunk: Buffer, done?: () => void): void {
    const link = this.link();
    if (!link.shaping && this.empty) {
      this.deliver(chunk);
      done?.();
      return;
    }
    let sentAt = 0;
    for (const slice of slicesOf(chunk)) {
      const timing = link.send(slice.length, performance.now());
      sentAt = timing.sentAt;
      this.lastArrival = Math.max(this.lastArrival, timing.arrivesAt);
      this.slices.push({ arrivesAt: this.lastArrival, chunk: slice });
      this.queuedBytes += slice.length;
    }
    this.schedule();
    if (done) this.whenSent(sentAt, done);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.sendTimers) clearTimeout(timer);
    this.sendTimers.clear();
    this.timer = null;
    this.slices = [];
    this.queuedBytes = 0;
  }

  private whenSent(sentAt: number, done: () => void): void {
    const wait = sentAt - performance.now();
    if (wait <= 0) {
      done();
      return;
    }
    const timer = setTimeout(() => {
      this.sendTimers.delete(timer);
      done();
    }, wait);
    this.sendTimers.add(timer);
  }

  private schedule(): void {
    const next = this.slices[0];
    if (this.timer || !next) return;
    const wait = Math.max(0, next.arrivesAt - performance.now());
    this.timer = setTimeout(() => this.deliverDue(), wait);
  }

  private deliverDue(): void {
    this.timer = null;
    const now = performance.now();
    while (this.slices[0] && this.slices[0].arrivesAt <= now) {
      const slice = this.slices.shift()!;
      this.queuedBytes -= slice.chunk.length;
      this.deliver(slice.chunk);
    }
    if (this.empty) this.onDrain();
    this.schedule();
  }
}

/**
 * The device's connection to the proxy as the link delivers it: what the device
 * sends arrives after the upload delay, what the proxy writes after the download delay.
 */
class ShapedSocket extends Duplex {
  private bypassed: boolean | null = null;
  private readonly upload: DelayedQueue;
  private readonly download: DelayedQueue;
  private deviceEnded = false;
  private pendingFinal: (() => void) | null = null;
  private writerWaiting: (() => void) | null = null;
  private uploadsSending = 0;
  private proxyFull = false;

  constructor(
    readonly socket: net.Socket,
    private readonly links: { upload: LinkDirection; download: LinkDirection },
    private readonly isBypassed: (requestLine: string) => boolean
  ) {
    super();
    this.upload = new DelayedQueue(
      () => this.linkFor("upload"),
      (chunk) => this.deliverToProxy(chunk),
      () => this.onUploadDrain()
    );
    this.download = new DelayedQueue(
      () => this.linkFor("download"),
      (chunk) => this.deliverToDevice(chunk),
      () => this.onDownloadDrain()
    );
    socket.on("data", (chunk: Buffer) => this.onDeviceData(chunk));
    socket.on("end", () => this.onDeviceEnd());
    socket.on("error", (err) => this.destroy(err));
    socket.on("close", () => this.destroy());
  }

  setNoDelay(noDelay?: boolean): this {
    this.socket.setNoDelay(noDelay);
    return this;
  }

  override _read(): void {
    this.proxyFull = false;
    this.resumeDevice();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.download.push(chunk, () => this.whenDeviceHasRoom(callback));
  }

  override _final(callback: () => void): void {
    this.pendingFinal = () => {
      this.socket.end();
      callback();
    };
    if (this.download.empty) this.onDownloadDrain();
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this.upload.clear();
    this.download.clear();
    this.socket.destroy();
    callback(err);
  }

  private linkFor(direction: "upload" | "download"): LinkDirection {
    return this.bypassed ? UNSHAPED : this.links[direction];
  }

  private queueLimit(direction: "upload" | "download"): number {
    return this.linkFor(direction).limited ? MAX_LIMITED_QUEUED_BYTES : MAX_QUEUED_BYTES;
  }

  private onDeviceData(chunk: Buffer): void {
    this.bypassed ??= this.isBypassed(firstLine(chunk));
    this.uploadsSending++;
    this.socket.pause();
    this.upload.push(chunk, () => {
      this.uploadsSending--;
      this.resumeDevice();
    });
  }

  private onDeviceEnd(): void {
    this.deviceEnded = true;
    if (this.upload.empty) this.push(null);
  }

  private whenDeviceHasRoom(callback: () => void): void {
    if (this.download.queuedBytes >= this.queueLimit("download")) this.writerWaiting = callback;
    else if (this.socket.writableNeedDrain) this.socket.once("drain", callback);
    else callback();
  }

  private deliverToDevice(chunk: Buffer): void {
    this.socket.write(chunk);
    const waiting = this.writerWaiting;
    if (waiting && this.download.queuedBytes < this.queueLimit("download") / 2) {
      this.writerWaiting = null;
      this.whenDeviceHasRoom(waiting);
    }
  }

  private resumeDevice(): void {
    const hasRoom = this.upload.queuedBytes < this.queueLimit("upload") / 2;
    if (this.uploadsSending === 0 && !this.proxyFull && hasRoom) this.socket.resume();
  }

  private deliverToProxy(chunk: Buffer): void {
    if (this.push(chunk)) {
      this.resumeDevice();
      return;
    }
    this.proxyFull = true;
    this.socket.pause();
  }

  private onUploadDrain(): void {
    if (this.deviceEnded) this.push(null);
  }

  private onDownloadDrain(): void {
    const final = this.pendingFinal;
    this.pendingFinal = null;
    final?.();
  }
}

function firstLine(chunk: Buffer): string {
  const end = chunk.indexOf("\r\n");
  return chunk.toString("latin1", 0, end === -1 ? Math.min(chunk.length, 8192) : end);
}

/** The host and port a proxy request line names: `CONNECT host:port ...` or `GET http://host:port/... ...`. */
export function requestLineTarget(line: string): ProxyTarget | null {
  const [method, target = ""] = line.split(" ");
  if (method === "CONNECT") return parseAuthority(target);
  const url = URL.parse(target);
  if (!url || url.protocol !== "http:") return null;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(authority);
  const port = Number(match?.[2]);
  return match && port <= 65535 ? { host: match[1]!, port } : null;
}

function forwardedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name))
  );
}

/** The request head for the origin: origin-form path, the device's headers without the proxy's own. */
function originRequestHead(req: http.IncomingMessage, path: string): string {
  const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (!PROXY_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
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
 * between the device and the proxy, for plain requests and CONNECT tunnels alike.
 */
export async function startShapingProxy(options: ShapingProxyOptions): Promise<ShapingProxy> {
  const { resolveTarget } = options;
  const links = { upload: new LinkDirection(), download: new LinkDirection() };
  const sockets = new Set<net.Socket>();
  const agent = new http.Agent({ keepAlive: true });

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, path: string) => {
    return (target: ProxyTarget | null): void => {
      if (res.destroyed) return;
      if (!target) {
        res.writeHead(502).end();
        return;
      }
      const upstream = http.request({
        agent,
        host: target.host,
        port: target.port,
        method: req.method,
        path,
        headers: forwardedHeaders(req.headers),
      });
      upstream.on("response", (response) => {
        const headers = forwardedHeaders(response.headers);
        try {
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
      req.pipe(upstream);
    };
  };

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = URL.parse(req.url ?? "");
    if (!url) {
      res.writeHead(400).end();
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 80);
    void resolveTarget(host, port)
      .catch(() => null)
      .then(forward(req, res, `${url.pathname}${url.search}`));
  };

  /** Joins the device's connection to the target once `start` has opened the stream. */
  const pipeToTarget = (client: Duplex, start: (upstream: net.Socket) => void) => {
    let upstream: net.Socket | null = null;
    const stopUpstream = (): void => {
      upstream?.destroy();
    };
    client.on("error", stopUpstream);
    return (target: ProxyTarget | null): void => {
      if (client.destroyed) return;
      if (!target) {
        client.end(BAD_GATEWAY);
        return;
      }
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
  };

  const refuse = (client: Duplex, response: string): void => {
    client.on("error", () => client.destroy());
    client.end(response);
  };

  const onConnect = (req: http.IncomingMessage, client: Duplex, head: Buffer): void => {
    const authority = parseAuthority(req.url ?? "");
    if (!authority) {
      refuse(client, BAD_GATEWAY);
      return;
    }
    const start = (upstream: net.Socket): void => {
      client.write(TUNNEL_ESTABLISHED);
      if (head.length > 0) upstream.write(head);
    };
    void resolveTarget(authority.host, authority.port)
      .catch(() => null)
      .then(pipeToTarget(client, start));
  };

  const onUpgrade = (req: http.IncomingMessage, client: Duplex, head: Buffer): void => {
    const target = requestLineTarget(`GET ${req.url ?? ""}`);
    const url = URL.parse(req.url ?? "");
    if (!target || !url) {
      refuse(client, BAD_REQUEST);
      return;
    }
    const start = (upstream: net.Socket): void => {
      upstream.write(originRequestHead(req, `${url.pathname}${url.search}`));
      if (head.length > 0) upstream.write(head);
    };
    void resolveTarget(target.host, target.port)
      .catch(() => null)
      .then(pipeToTarget(client, start));
  };

  const isBypassed = (requestLine: string): boolean => {
    const target = requestLineTarget(requestLine);
    return target !== null && options.bypass(target.host, target.port);
  };

  const server = http.createServer({ requestTimeout: 0 }, onRequest);
  server.on("connect", onConnect);
  server.on("upgrade", onUpgrade);
  const listener = net.createServer({ allowHalfOpen: true }, (socket) => {
    track(socket);
    server.emit("connection", new ShapedSocket(socket, links, isBypassed));
  });
  const port = await listen(listener);

  return {
    port,
    setConditions(conditions) {
      links.upload.configure(conditions?.uploadKbps, conditions?.latencyMs);
      links.download.configure(conditions?.downloadKbps, conditions?.latencyMs);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      server.close();
    },
  };
}
