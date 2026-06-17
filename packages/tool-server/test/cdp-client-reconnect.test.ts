import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { CDPClient } from "../src/utils/debugger/cdp-client";

/** Minimal CDP-ish echo server: replies to any request with `{ server: <id> }`. */
function startEchoServer(serverId: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}/devtools/page/${serverId}`,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        sock.send(JSON.stringify({ id: msg.id, result: { server: serverId } }));
      });
    });
  });
}

describe("CDPClient.reconnect", () => {
  it("re-points to a new target without emitting `disconnected`", async () => {
    const s1 = await startEchoServer(1);
    const s2 = await startEchoServer(2);
    const cdp = new CDPClient(s1.url, { sendOrigin: false });
    await cdp.connect();

    let disconnects = 0;
    cdp.events.on("disconnected", () => {
      disconnects++;
    });

    expect(await cdp.send("Test.ping")).toEqual({ server: 1 });

    await cdp.reconnect(s2.url);

    // Switched in place: same object, now talking to server 2, still connected,
    // and crucially NO disconnected event fired (callers wire that to teardown).
    expect(cdp.isConnected()).toBe(true);
    expect(await cdp.send("Test.ping")).toEqual({ server: 2 });
    expect(disconnects).toBe(0);

    await cdp.disconnect();
    await s1.close();
    await s2.close();
  });

  it("rejects in-flight requests on the old socket when reconnecting", async () => {
    // A server that never replies, so the request is still pending at reconnect.
    const silent = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
        const addr = wss.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          url: `ws://127.0.0.1:${port}/devtools/page/silent`,
          close: () => new Promise<void>((r) => wss.close(() => r())),
        });
      });
    });
    const s2 = await startEchoServer(9);
    const cdp = new CDPClient(silent.url, { sendOrigin: false });
    await cdp.connect();

    const pending = cdp.send("Test.neverReplies", {}, 5000);
    const settled = pending.then(
      () => "resolved",
      (e) => `rejected:${(e as Error).message}`
    );

    await cdp.reconnect(s2.url);
    await expect(settled).resolves.toContain("rejected");
    expect(await cdp.send("Test.ping")).toEqual({ server: 9 });

    await cdp.disconnect();
    await silent.close();
    await s2.close();
  });
});
