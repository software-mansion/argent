import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo, Socket } from "node:net";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../src/utils/debugger/cdp-client";

/** Accepts the upgrade's TCP connection and never answers it. */
function startSilentUpgradeServer(): Promise<{
  url: string;
  upgraded: Promise<Socket>;
  server: Server;
}> {
  let onUpgrade!: (socket: Socket) => void;
  const upgraded = new Promise<Socket>((r) => (onUpgrade = r));
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    // Reading is what surfaces the client's FIN as `end`.
    socket.resume();
    onUpgrade(socket as Socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${port}/devtools/page/silent`, upgraded, server });
    });
  });
}

describe("CDPClient.connect", () => {
  let server: Server | undefined;
  let socket: Socket | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    socket?.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = socket = undefined;
  });

  it("rejects and drops the socket when the upgrade is never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const silent = await startSilentUpgradeServer();
    server = silent.server;
    const cdp = new CDPClient(silent.url, { sendOrigin: false });

    const settled = cdp.connect().then(
      () => "resolved",
      (err: unknown) => err
    );
    socket = await silent.upgraded;
    const ended = new Promise<void>((r) => socket!.once("end", () => r()));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(FailureError);
    expect((err as FailureError).message).toBe(
      `CDP WebSocket handshake with ${silent.url} did not complete within 10000ms. The host` +
        " may be unreachable, or the target frozen or not a CDP endpoint."
    );
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
      error_kind: "timeout",
      network_failure: "timeout",
    });
    await ended;
    expect(cdp.isConnected()).toBe(false);
  });

  it("leaves an opened connection up once the handshake deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wss = await new Promise<WebSocketServer>((r) => {
      const w: WebSocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => r(w));
    });
    const { port } = wss.address() as AddressInfo;
    const cdp = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/ok`, { sendOrigin: false });
    await cdp.connect();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(cdp.isConnected()).toBe(true);

    vi.useRealTimers();
    await cdp.disconnect();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
