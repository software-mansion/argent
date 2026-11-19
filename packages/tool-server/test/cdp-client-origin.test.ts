import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../src/utils/debugger/cdp-client";
import { metroOriginCandidates } from "../src/utils/debugger/metro-origin";

/**
 * A Metro behind Expo's dev server. Like React Native's inspector proxy, each
 * upgrade first evicts the socket already on the page (close 1000,
 * `[NEW_DEBUGGER_OPENED]`), or with `pageMissing` closes the new one (1011,
 * `[PAGE_NOT_FOUND]`). Then, like Expo, it terminates the socket unless the
 * Origin's host is `expectedHost`. Answers `Runtime.evaluate` on a kept socket.
 * `manifestHost` makes `GET /` answer an Expo manifest whose bundle URL is on
 * that host.
 */
async function startExpoLikeMetro(options: {
  expectedHost: (port: number) => string;
  manifestHost?: (port: number) => string;
  pageMissing?: boolean;
}) {
  const origins: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/" && options.manifestHost) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          launchAsset: { url: `http://${options.manifestHost(port)}/index.bundle?platform=ios` },
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  let port = 0;
  let attached: import("ws").WebSocket | undefined;
  wss.on("connection", (socket, req) => {
    origins.push(req.headers.origin);
    if (options.pageMissing) {
      socket.close(1011, "[PAGE_NOT_FOUND] Debugger page not found");
      return;
    }
    attached?.close(1000, "[NEW_DEBUGGER_OPENED] New debugger opened for the same app instance");
    attached = socket;
    const host = req.headers.origin ? new URL(req.headers.origin).host : undefined;
    if (host !== options.expectedHost(port)) {
      socket.terminate();
      return;
    }
    socket.on("message", (raw) => {
      const { id } = JSON.parse(raw.toString()) as { id: number };
      socket.send(JSON.stringify({ id, result: { result: { type: "number", value: 42 } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return {
    url: `ws://localhost:${port}/inspector/debug?device=d&page=1`,
    port,
    origins,
    close: () => {
      for (const socket of wss.clients) socket.terminate();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("CDPClient Origin negotiation with Metro", () => {
  let metro: Awaited<ReturnType<typeof startExpoLikeMetro>> | undefined;
  let client: CDPClient | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await client?.disconnect();
    await metro?.close();
    metro = client = undefined;
  });

  it("sends 127.0.0.1 first and keeps the socket Expo's default accepts", async () => {
    metro = await startExpoLikeMetro({ expectedHost: (port) => `127.0.0.1:${port}` });
    client = new CDPClient(metro.url);

    await client.connect();

    expect(metro.origins).toEqual([`http://127.0.0.1:${metro.port}`]);
    expect(await client.send("Runtime.evaluate", { expression: "40+2" })).toMatchObject({
      result: { value: 42 },
    });
  });

  it("finds the host REACT_NATIVE_PACKAGER_HOSTNAME moved Expo to (issue 801)", async () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", "devbox.test");
    metro = await startExpoLikeMetro({ expectedHost: (port) => `devbox.test:${port}` });
    client = new CDPClient(metro.url);
    const disconnected = vi.fn();
    client.events.on("disconnected", disconnected);

    await client.connect();

    expect(metro.origins.at(-1)).toBe(`http://devbox.test:${metro.port}`);
    expect(metro.origins[0]).toBe(`http://127.0.0.1:${metro.port}`);
    expect(await client.send("Runtime.evaluate", { expression: "40+2" })).toMatchObject({
      result: { value: 42 },
    });
    // The dropped attempts are not a lost device.
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("starts from the Origin that worked last time", async () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", "devbox.test");
    metro = await startExpoLikeMetro({ expectedHost: (port) => `devbox.test:${port}` });
    const first = new CDPClient(metro.url);
    await first.connect();
    await first.disconnect();
    metro.origins.length = 0;

    client = new CDPClient(metro.url);
    await client.connect();

    expect(metro.origins).toEqual([`http://devbox.test:${metro.port}`]);
  });

  it("asks Expo's manifest before guessing, so no upgrade evicts the attached debugger", async () => {
    metro = await startExpoLikeMetro({
      expectedHost: (port) => `bundles.test:${port}`,
      manifestHost: (port) => `bundles.test:${port}`,
    });
    client = new CDPClient(metro.url);

    await client.connect();

    expect(metro.origins).toEqual([`http://bundles.test:${metro.port}`]);
    expect(client.isConnected()).toBe(true);
  });

  it("does not read another debugger taking the page as a refused Origin", async () => {
    metro = await startExpoLikeMetro({
      expectedHost: (port) => `bundles.test:${port}`,
      manifestHost: (port) => `bundles.test:${port}`,
    });
    const other = new CDPClient(metro.url);
    client = new CDPClient(metro.url);

    // Two clients inside one settle window: whichever upgrades last evicts the
    // other, which is a lost socket, not a reason to try more Origins.
    await Promise.all([other.connect(), client.connect()]);

    expect(metro.origins).toEqual([
      `http://bundles.test:${metro.port}`,
      `http://bundles.test:${metro.port}`,
    ]);
    expect([other.isConnected(), client.isConnected()].filter(Boolean)).toHaveLength(1);
    await other.disconnect();
  });

  it("reports a page React Native cannot find as a lost socket, not an Origin problem", async () => {
    metro = await startExpoLikeMetro({
      expectedHost: (port) => `127.0.0.1:${port}`,
      pageMissing: true,
    });
    client = new CDPClient(metro.url);
    const events: string[] = [];
    client.events.on("connected", () => events.push("connected"));
    client.events.on("disconnected", () => events.push("disconnected"));

    await client.connect();

    expect(metro.origins).toHaveLength(1);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(client.isConnected()).toBe(false);
  });

  it("names the Origin problem when no candidate is kept", async () => {
    metro = await startExpoLikeMetro({ expectedHost: () => "nowhere.test:1" });
    client = new CDPClient(metro.url);

    const err = await client.connect().then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_ORIGIN_REJECTED,
      failure_stage: "debugger_cdp_connect",
    });
    expect((err as Error).message).toContain("REACT_NATIVE_PACKAGER_HOSTNAME");
    expect((err as Error).message).toContain(`http://127.0.0.1:${metro.port}`);
    expect(client.isConnected()).toBe(false);
  });
});

describe("CDPClient without an Origin (Chromium)", () => {
  it("reports a socket that fails to open as disconnected", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 404 Not Found\r\n\r\n"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const chromium = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/x`, {
      sendOrigin: false,
    });
    const disconnected = vi.fn();
    chromium.events.on("disconnected", disconnected);

    await expect(chromium.connect()).rejects.toThrow(/404/);

    expect(disconnected).toHaveBeenCalled();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("metroOriginCandidates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("puts 127.0.0.1 first, without duplicates", () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", " 127.0.0.1 ");
    const candidates = metroOriginCandidates("ws://localhost:8081/inspector/debug");

    expect(candidates.slice(0, 2)).toEqual(["http://127.0.0.1:8081", "http://localhost:8081"]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("brackets an IPv6 packager hostname", () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", "fd00::5");
    expect(metroOriginCandidates("ws://localhost:8081/x")).toContain("http://[fd00::5]:8081");
  });
});
