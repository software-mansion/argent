import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { connectCdp } from "../src/chromium-server/cdp-session";

interface FakeBrowser {
  port: number;
  createdUrls: string[];
  close: () => Promise<void>;
}

/** A browser with no page targets; `Target.createTarget` adds one unless `supportsCreate` is false. */
async function startWindowlessBrowser(supportsCreate: boolean): Promise<FakeBrowser> {
  const createdUrls: string[] = [];
  const server = http.createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/b` })
      );
      return;
    }
    if (req.url === "/json/list") {
      res.end(
        JSON.stringify(
          createdUrls.map((url, i) => ({
            id: `page${i}`,
            type: "page",
            title: "",
            url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page${i}`,
          }))
        )
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { url?: string };
      };
      if (msg.method === "Target.createTarget") {
        if (!supportsCreate) {
          ws.send(
            JSON.stringify({ id: msg.id, error: { code: -32000, message: "Not supported" } })
          );
          return;
        }
        createdUrls.push(msg.params?.url ?? "");
        ws.send(
          JSON.stringify({ id: msg.id, result: { targetId: `page${createdUrls.length - 1}` } })
        );
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    port: (server.address() as AddressInfo).port,
    createdUrls,
    close: () => new Promise<void>((ok) => wss.close(() => server.close(() => ok()))),
  };
}

const browsers: FakeBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((b) => b.close()));
});

describe("connectCdp with no tab open", () => {
  it("opens a blank tab and connects to it", async () => {
    const browser = await startWindowlessBrowser(true);
    browsers.push(browser);

    const { cdp, target, openedBlank } = await connectCdp(browser.port);
    await cdp.disconnect();

    expect(browser.createdUrls).toEqual(["about:blank"]);
    expect(target.id).toBe("page0");
    expect(openedBlank).toBe(true);
  });

  it("keeps the no-page error when the runtime cannot create a target", async () => {
    const browser = await startWindowlessBrowser(false);
    browsers.push(browser);

    const err = await connectCdp(browser.port).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET);
  });
});
