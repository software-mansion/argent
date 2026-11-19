import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../src/utils/debugger/cdp-client";
import { metroOriginCandidates } from "../src/utils/debugger/metro-origin";

/**
 * A Metro behind Expo's dev server: the upgrade completes for any Origin, then
 * the socket is terminated unless the Origin's host is `expectedHost`. Answers
 * `Runtime.evaluate` on a kept socket. `manifestHost` makes `GET /` answer an
 * Expo manifest whose bundle URL is on that host.
 */
async function startExpoLikeMetro(options: {
  expectedHost: (port: number) => string;
  manifestHost?: (port: number) => string;
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
  wss.on("connection", (socket, req) => {
    origins.push(req.headers.origin);
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

  it("falls back to the host in Expo's manifest", async () => {
    metro = await startExpoLikeMetro({
      expectedHost: (port) => `bundles.test:${port}`,
      manifestHost: (port) => `bundles.test:${port}`,
    });
    client = new CDPClient(metro.url);

    await client.connect();

    expect(metro.origins.at(-1)).toBe(`http://bundles.test:${metro.port}`);
    expect(client.isConnected()).toBe(true);
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

describe("metroOriginCandidates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("puts the remembered Origin first, then 127.0.0.1, without duplicates", () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", " 127.0.0.1 ");
    const candidates = metroOriginCandidates(
      "ws://localhost:8081/inspector/debug",
      "http://10.0.0.2:8081"
    );

    expect(candidates.slice(0, 3)).toEqual([
      "http://10.0.0.2:8081",
      "http://127.0.0.1:8081",
      "http://localhost:8081",
    ]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("brackets an IPv6 packager hostname", () => {
    vi.stubEnv("REACT_NATIVE_PACKAGER_HOSTNAME", "fd00::5");
    expect(metroOriginCandidates("ws://localhost:8081/x")).toContain("http://[fd00::5]:8081");
  });
});
