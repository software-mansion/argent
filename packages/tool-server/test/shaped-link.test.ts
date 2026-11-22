import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { LinkDirection, ShapedLink } from "../src/utils/shaped-link";

const LATENCY_MS = 300;
const SLACK_MS = 60;
const BOUNDED_BYTES = 64 * 1024 * 1024;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function startShapedServer(
  onDevice: (shaped: Duplex) => void,
  isBypassed: (requestLine: string) => boolean = () => false
) {
  const link = new ShapedLink();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const shaped = link.attach(socket, isBypassed);
    shaped.on("error", () => {});
    onDevice(shaped);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  return { link, port };
}

async function connectDevice(port: number): Promise<net.Socket> {
  const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  socket.on("error", () => {});
  cleanups.push(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  return socket;
}

function echo(shaped: Duplex): void {
  shaped.pipe(shaped);
}

async function timeEcho(device: net.Socket, message = "ping"): Promise<number> {
  const started = performance.now();
  let received = "";
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      received += chunk.toString();
      if (received.length < message.length) return;
      device.off("data", onData);
      resolve();
    };
    device.on("data", onData);
    device.write(message);
  });
  return performance.now() - started;
}

function receiveAll(device: net.Socket, bytes: number): Promise<number> {
  const started = performance.now();
  let received = 0;
  return new Promise((resolve) => {
    device.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received >= bytes) resolve(performance.now() - started);
    });
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function floodWithBackpressure(stream: net.Socket | Duplex): () => number {
  const chunk = Buffer.alloc(1024 * 1024, 97);
  let written = 0;
  const writeMore = (): void => {
    let room = true;
    while (room && !stream.destroyed) {
      room = stream.write(chunk);
      written += chunk.length;
    }
    if (!stream.destroyed) stream.once("drain", writeMore);
  };
  writeMore();
  return () => written;
}

describe("LinkDirection", () => {
  it("delays by half the latency, as each direction carries half a round trip", () => {
    const link = new LinkDirection();
    link.configure(undefined, 400);

    expect(link.send(1000, 0)).toEqual({ sentAt: 0, arrivesAt: 200 });
  });

  it("sends bytes back to back at the speed limit and credits at most 20 ms of idle link", () => {
    const link = new LinkDirection();
    link.configure(800, undefined);

    expect(link.send(1000, 0)).toEqual({ sentAt: 10, arrivesAt: 10 });
    expect(link.send(1000, 0)).toEqual({ sentAt: 20, arrivesAt: 20 });
    expect(link.send(1000, 100)).toEqual({ sentAt: 90, arrivesAt: 100 });
  });

  it("forgets the speed limit's backlog when the conditions change", () => {
    const link = new LinkDirection();
    link.configure(8, undefined);
    link.send(60_000, 0);

    expect(link.configure(undefined, 100)).toBe(true);
    expect(link.configure(undefined, 100)).toBe(false);
    expect(link.send(10, 1_000)).toEqual({ sentAt: 1_000, arrivesAt: 1_050 });
  });
});

describe("ShapedLink", () => {
  it("passes data straight through without conditions", async () => {
    const { port } = await startShapedServer(echo);
    const device = await connectDevice(port);

    expect(await timeEcho(device)).toBeLessThan(LATENCY_MS / 2);
  });

  it("adds the latency to every round trip and drops it at a reset", async () => {
    const { link, port } = await startShapedServer(echo);
    const device = await connectDevice(port);
    link.setConditions({ latencyMs: LATENCY_MS });

    const first = await timeEcho(device);
    const second = await timeEcho(device);
    link.setConditions(null);
    const cleared = await timeEcho(device);

    expect(first).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(second).toBeGreaterThan(LATENCY_MS - SLACK_MS);
    expect(second).toBeLessThan(LATENCY_MS * 2);
    expect(cleared).toBeLessThan(LATENCY_MS / 2);
  });

  it("limits the download speed", async () => {
    const { link, port } = await startShapedServer((shaped) => shaped.end(Buffer.alloc(50_000)));
    link.setConditions({ downloadKbps: 1000 });

    const ms = await receiveAll(await connectDevice(port), 50_000);

    expect(ms).toBeGreaterThan(400 - SLACK_MS);
    expect(ms).toBeLessThan(400 * 2);
  });

  it("limits the upload speed", async () => {
    let received = 0;
    const { link, port } = await startShapedServer((shaped) =>
      shaped.on("data", (chunk: Buffer) => (received += chunk.length))
    );
    link.setConditions({ uploadKbps: 1000 });
    const device = await connectDevice(port);

    const started = performance.now();
    device.write(Buffer.alloc(50_000));
    await waitFor(() => received >= 50_000);
    const ms = performance.now() - started;

    expect(ms).toBeGreaterThan(400 - SLACK_MS);
    expect(ms).toBeLessThan(400 * 2);
  });

  it.each([
    { name: "a reset", next: null },
    { name: "faster conditions", next: { downloadKbps: 100_000 } },
  ])("frees a download that is mid-transfer at $name", async ({ next }) => {
    const { link, port } = await startShapedServer((shaped) => shaped.end(Buffer.alloc(200_000)));
    link.setConditions({ downloadKbps: 8 });
    const download = receiveAll(await connectDevice(port), 200_000);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const changed = performance.now();
    link.setConditions(next);
    await download;

    expect(performance.now() - changed).toBeLessThan(1_000);
  });

  it("keeps a download at its speed when only the upload conditions change", async () => {
    const { link, port } = await startShapedServer((shaped) => shaped.end(Buffer.alloc(100_000)));
    link.setConditions({ downloadKbps: 1000, uploadKbps: 1000 });
    const download = receiveAll(await connectDevice(port), 100_000);

    await new Promise((resolve) => setTimeout(resolve, 200));
    link.setConditions({ downloadKbps: 1000, uploadKbps: 2000 });

    expect(await download).toBeLessThan(800 + 4 * SLACK_MS);
  });

  it("leaves a connection unshaped while its first request line is bypassed", async () => {
    let bypassed = true;
    const { link, port } = await startShapedServer(echo, (line) => bypassed && line === "GET /a");
    const device = await connectDevice(port);
    link.setConditions({ latencyMs: LATENCY_MS });

    const whileBypassed = await timeEcho(device, "GET /a\r\n");
    bypassed = false;
    const afterwards = await timeEcho(device, "next");

    expect(whileBypassed).toBeLessThan(LATENCY_MS / 2);
    expect(afterwards).toBeGreaterThan(LATENCY_MS - SLACK_MS);
  });

  it("delivers what is queued before it passes on the server's half-close", async () => {
    const { link, port } = await startShapedServer((shaped) => shaped.end(Buffer.alloc(100_000)));
    link.setConditions({ latencyMs: LATENCY_MS });
    const device = await connectDevice(port);

    let received = 0;
    device.on("data", (chunk: Buffer) => (received += chunk.length));
    await new Promise((resolve) => device.once("end", resolve));

    expect(received).toBe(100_000);
  });

  it.each([null, { latencyMs: 200 }])(
    "stops taking server data while the device does not read, at %j",
    async (conditions) => {
      let written = (): number => 0;
      const { link, port } = await startShapedServer((shaped) => {
        written = floodWithBackpressure(shaped);
      });
      link.setConditions(conditions);
      const device = await connectDevice(port);
      device.pause();

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(written()).toBeGreaterThan(0);
      expect(written()).toBeLessThan(BOUNDED_BYTES * 1.5);
    }
  );

  it("stops reading the device while the server does not read", async () => {
    const { link, port } = await startShapedServer((shaped) => shaped.pause());
    link.setConditions({ uploadKbps: 1000 });
    const written = floodWithBackpressure(await connectDevice(port));

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(written()).toBeGreaterThan(0);
    expect(written()).toBeLessThan(BOUNDED_BYTES);
  });
});
