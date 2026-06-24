import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
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
