import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { isWebsocketUpgradeAllowed } from "../src/http";
import { attachChromiumServerWebsocket } from "../src/chromium-server/http-api";
import type { ChromiumServer } from "../src/chromium-server/types";

// http.ts pulls in the update-checker at import time; stub it so importing the
// module under test never reaches the network / filesystem.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const guard = { allowedHostnames: LOOPBACK, hostGuardDisabled: false };

describe("isWebsocketUpgradeAllowed", () => {
  it("allows the in-process preview UI (loopback Host + same-origin Origin)", () => {
    expect(
      isWebsocketUpgradeAllowed({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" }, guard)
    ).toBe(true);
    expect(
      isWebsocketUpgradeAllowed({ host: "localhost:3001", origin: "http://localhost:5173" }, guard)
    ).toBe(true);
    expect(
      isWebsocketUpgradeAllowed({ host: "[::1]:3001", origin: "http://[::1]:3001" }, guard)
    ).toBe(true);
  });

  it("allows a non-browser client on loopback (no Origin header)", () => {
    expect(isWebsocketUpgradeAllowed({ host: "127.0.0.1:3001" }, guard)).toBe(true);
  });

  it("rejects a cross-origin browser page (CSWSH — the reported issue)", () => {
    expect(
      isWebsocketUpgradeAllowed({ host: "127.0.0.1:3001", origin: "https://evil.com" }, guard)
    ).toBe(false);
    expect(
      isWebsocketUpgradeAllowed(
        { host: "127.0.0.1:3001", origin: "http://attacker.example:8080" },
        guard
      )
    ).toBe(false);
  });

  it("rejects an opaque / 'null' Origin (sandboxed iframe, file://)", () => {
    expect(isWebsocketUpgradeAllowed({ host: "127.0.0.1:3001", origin: "null" }, guard)).toBe(
      false
    );
  });

  it("rejects a DNS-rebinding Host (public hostname resolving to 127.0.0.1)", () => {
    expect(isWebsocketUpgradeAllowed({ host: "evil.com:3001" }, guard)).toBe(false);
    expect(
      isWebsocketUpgradeAllowed({ host: "evil.com:3001", origin: "http://127.0.0.1:3001" }, guard)
    ).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(isWebsocketUpgradeAllowed({}, guard)).toBe(false);
    expect(isWebsocketUpgradeAllowed({ origin: "http://127.0.0.1:3001" }, guard)).toBe(false);
  });

  it("honors an explicit non-loopback bind host", () => {
    const bound = {
      allowedHostnames: new Set([...LOOPBACK, "192.168.92.208"]),
      hostGuardDisabled: false,
    };
    expect(
      isWebsocketUpgradeAllowed(
        { host: "192.168.92.208:3001", origin: "http://192.168.92.208:3001" },
        bound
      )
    ).toBe(true);
    expect(
      isWebsocketUpgradeAllowed({ host: "192.168.92.208:3001", origin: "https://evil.com" }, bound)
    ).toBe(false);
  });

  it("is disabled by a wildcard bind (operator opted into network exposure)", () => {
    const wild = { allowedHostnames: LOOPBACK, hostGuardDisabled: true };
    expect(
      isWebsocketUpgradeAllowed({ host: "anything:3001", origin: "https://evil.com" }, wild)
    ).toBe(true);
    expect(isWebsocketUpgradeAllowed({}, wild)).toBe(true);
  });
});

describe("attachChromiumServerWebsocket — upgrade authorization wiring", () => {
  function setup(authorize: (req: IncomingMessage) => boolean) {
    const httpServer = new EventEmitter() as unknown as Server;
    const resolveServer = vi.fn((): ChromiumServer | null => null);
    attachChromiumServerWebsocket(httpServer, "/chromium-server/", resolveServer, authorize);
    const emitUpgrade = (
      headers: Record<string, string>,
      url = "/chromium-server/chromium-cdp-9222/ws"
    ) => {
      const socket = { destroy: vi.fn() };
      (httpServer as unknown as EventEmitter).emit(
        "upgrade",
        { url, headers } as unknown as IncomingMessage,
        socket,
        Buffer.alloc(0)
      );
      return socket;
    };
    return { resolveServer, emitUpgrade };
  }

  const realAuthorize = (req: IncomingMessage) =>
    isWebsocketUpgradeAllowed(req.headers as { host?: string; origin?: string }, guard);

  it("destroys the socket and never resolves the device for a cross-origin upgrade", () => {
    const { resolveServer, emitUpgrade } = setup(realAuthorize);
    const socket = emitUpgrade({ host: "127.0.0.1:3001", origin: "https://evil.com" });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(resolveServer).not.toHaveBeenCalled();
  });

  it("lets an allowed upgrade reach resolveServer", () => {
    const { resolveServer, emitUpgrade } = setup(realAuthorize);
    // resolveServer returns null in this stub, so the socket is still destroyed
    // afterwards — but reaching resolveServer proves the auth gate passed.
    emitUpgrade({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" });
    expect(resolveServer).toHaveBeenCalledTimes(1);
  });

  it("ignores upgrades for unrelated URLs without touching the socket", () => {
    const { resolveServer, emitUpgrade } = setup(() => true);
    const socket = emitUpgrade({ host: "127.0.0.1:3001" }, "/some/other/path");
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(resolveServer).not.toHaveBeenCalled();
  });
});

// End-to-end over a REAL http.Server + REAL `ws` handshake (not the synthetic
// EventEmitter above). Proves two things the unit/wiring tests structurally
// cannot: (1) an AUTHORIZED upgrade actually completes to a 101 and yields an
// open socket via wss.handleUpgrade → bindWsToServer; (2) a denied upgrade (or
// one with no device) is torn down at the wire with no 101 — observed by the
// client, not just an internal stub.
describe("attachChromiumServerWebsocket — real handshake (http.Server + ws client)", () => {
  let server: Server;
  let port: number;
  // When true, resolve to a minimal real ChromiumServer so an allowed upgrade
  // reaches 101 — bindWsToServer only touches `.events`, so an EventEmitter is
  // sufficient. When false, the device is "absent" (resolveServer → null).
  let resolvable = true;
  const device = { events: new EventEmitter() } as unknown as ChromiumServer;

  beforeAll(async () => {
    server = createServer();
    attachChromiumServerWebsocket(
      server,
      "/chromium-server/",
      () => (resolvable ? device : null),
      (req) => isWebsocketUpgradeAllowed(req.headers as { host?: string; origin?: string }, guard)
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Connect with crafted headers; settle to "open" (101) or "rejected" (no 101)
  // — never hang. A ws client sends no Origin unless one is supplied here, and
  // honors an explicit Host override (used for the DNS-rebind case).
  function handshake(headers: Record<string, string>): Promise<"open" | "rejected"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/chromium-server/dev/ws`, { headers });
      let settled = false;
      const done = (r: "open" | "rejected") => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already torn down */
        }
        resolve(r);
      };
      ws.on("open", () => done("open"));
      ws.on("error", () => done("rejected"));
      ws.on("unexpected-response", () => done("rejected"));
    });
  }

  it("completes the 101 handshake for a same-origin loopback client", async () => {
    resolvable = true;
    expect(await handshake({ Origin: `http://127.0.0.1:${port}` })).toBe("open");
  });

  it("completes for a non-browser client that sends no Origin", async () => {
    resolvable = true;
    expect(await handshake({})).toBe("open");
  });

  it("rejects a cross-origin browser handshake at the wire (CSWSH, no 101)", async () => {
    resolvable = true;
    expect(await handshake({ Origin: "https://evil.com" })).toBe("rejected");
  });

  it("rejects a DNS-rebinding Host at the wire", async () => {
    resolvable = true;
    expect(await handshake({ Host: `evil.com:${port}` })).toBe("rejected");
  });

  it("tears down an authorized upgrade when no device is resolved (no 101)", async () => {
    resolvable = false; // auth passes; resolveServer returns null
    expect(await handshake({ Origin: `http://127.0.0.1:${port}` })).toBe("rejected");
  });
});
