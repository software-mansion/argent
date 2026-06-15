import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  CHROMIUM_CDP_NAMESPACE,
  discoverPrimaryPage,
  chromiumCdpBlueprint,
  chromiumCdpRef,
  ensureCdpReachable,
} from "../src/blueprints/chromium-cdp";
import { resolveDevice } from "../src/utils/device-info";

interface FakeCdp {
  port: number;
  http: http.Server;
  ws: WebSocketServer;
  close: () => Promise<void>;
  /** All CDP method names the fake server has received. */
  recordedMethods: string[];
  /** Inject custom replies for specific methods (otherwise default replies are used). */
  setReply: (
    method: string,
    payload: Record<string, unknown> | ((id: number) => Record<string, unknown>)
  ) => void;
}

async function startFakeCdp(): Promise<FakeCdp> {
  const recordedMethods: string[] = [];
  const customReplies = new Map<
    string,
    Record<string, unknown> | ((id: number) => Record<string, unknown>)
  >();

  const httpSrv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(
        JSON.stringify({
          "Browser": "Chrome/Test",
          "Protocol-Version": "1.3",
        })
      );
      return;
    }
    if (req.url === "/json/list") {
      const port = (httpSrv.address() as AddressInfo).port;
      res.end(
        JSON.stringify([
          {
            id: "page1",
            type: "page",
            title: "T",
            url: "about:blank",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page1`,
          },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => httpSrv.listen(0, "127.0.0.1", resolve));
  const port = (httpSrv.address() as AddressInfo).port;

  const wss = new WebSocketServer({ server: httpSrv });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params?: unknown;
        };
        recordedMethods.push(msg.method);
        let result: unknown;
        const custom = customReplies.get(msg.method);
        if (custom !== undefined) {
          result = typeof custom === "function" ? custom(msg.id) : custom;
        } else {
          // Default replies — enough to let the blueprint factory finish.
          switch (msg.method) {
            case "Runtime.evaluate":
              // The factory's viewport probe expects a JSON string back.
              result = {
                result: { type: "string", value: JSON.stringify({ w: 800, h: 600, dpr: 1 }) },
              };
              break;
            case "DOM.getDocument":
              result = { root: { nodeId: 1, backendNodeId: 100 } };
              break;
            case "Page.enable":
            case "DOM.enable":
            case "Accessibility.enable":
              result = {};
              break;
            case "Input.dispatchMouseEvent":
            case "Input.dispatchKeyEvent":
            case "Page.navigate":
              result = {};
              break;
            case "Page.captureScreenshot":
              result = {
                // 1x1 transparent PNG
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=",
              };
              break;
            case "Accessibility.getFullAXTree":
              result = { nodes: [] };
              break;
            default:
              result = {};
          }
        }
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        // Ignore malformed payloads — the blueprint guards against bad replies on its own.
      }
    });
  });

  return {
    port,
    http: httpSrv,
    ws: wss,
    recordedMethods,
    setReply: (method, payload) => customReplies.set(method, payload),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpSrv.close(() => resolve()));
      }),
  };
}

const servers: FakeCdp[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe("chromiumCdpBlueprint (smoke)", () => {
  it("namespace + URN are stable", () => {
    expect(CHROMIUM_CDP_NAMESPACE).toBe("ChromiumCdp");
    const ref = chromiumCdpRef(resolveDevice("chromium-cdp-9222"));
    expect(ref.urn).toBe("ChromiumCdp:chromium-cdp-9222");
    expect(ref.options.device.platform).toBe("chromium");
  });

  it("discoverPrimaryPage returns the first non-devtools page target", async () => {
    const s = await startFakeCdp();
    servers.push(s);
    const target = await discoverPrimaryPage(s.port);
    expect(target.type).toBe("page");
    expect(target.webSocketDebuggerUrl).toMatch(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/page1/);
  });

  it("ensureCdpReachable returns the /json/version payload", async () => {
    const s = await startFakeCdp();
    servers.push(s);
    const ver = await ensureCdpReachable(s.port);
    expect(ver.Browser).toBe("Chrome/Test");
  });

  it("factory: connects, primes domains, exposes a working api", async () => {
    const s = await startFakeCdp();
    servers.push(s);
    const device = resolveDevice(`chromium-cdp-${s.port}`);
    const instance = await chromiumCdpBlueprint.factory({}, device, { device });

    try {
      expect(instance.api.port).toBe(s.port);
      // Viewport was probed during factory.
      expect(instance.api.getViewport()).toEqual({ width: 800, height: 600, devicePixelRatio: 1 });

      // Dispatch a mouse event — fake server should record it.
      await instance.api.dispatchMouseEvent({
        type: "mousePressed",
        x: 100,
        y: 50,
        clickCount: 1,
      });
      expect(s.recordedMethods).toContain("Input.dispatchMouseEvent");

      // Screenshot — fake server returns a tiny PNG, we expect a real file
      // path in the unified media dir maintained by the chromium-server.
      const shot = await instance.api.captureScreenshot();
      expect(shot.path).toMatch(/argent-chromium-media/);
      expect(shot.path).toMatch(/argent-screenshot-/);
      expect(shot.url).toMatch(/^file:\/\//);
    } finally {
      await instance.dispose();
    }
  });

  it("factory can synthesize the device from a string URN payload when no options.device is given", async () => {
    // This path matters for transitive dep resolution — see the registry's
    // _resolve, which only forwards the URN string into the factory, not the
    // ServiceRef options. The ChromiumJsRuntimeDebugger blueprint depends on
    // ChromiumCdp via getDependencies and reaches this branch.
    const s = await startFakeCdp();
    servers.push(s);
    const payload = `chromium-cdp-${s.port}`;
    const instance = await chromiumCdpBlueprint.factory(
      {},
      payload as unknown as ReturnType<typeof resolveDevice>,
      undefined as unknown as Record<string, unknown>
    );
    try {
      expect(instance.api.port).toBe(s.port);
    } finally {
      await instance.dispose();
    }
  });

  it("factory rejects when neither options.device nor a valid URN payload is given", async () => {
    await expect(
      chromiumCdpBlueprint.factory(
        {},
        undefined as unknown as ReturnType<typeof resolveDevice>,
        undefined as unknown as Record<string, unknown>
      )
    ).rejects.toThrow(/could not determine the device/);
  });

  it("factory rejects when options.device.id disagrees with the URN payload", async () => {
    const s = await startFakeCdp();
    servers.push(s);
    const device = resolveDevice(`chromium-cdp-${s.port}`);
    const otherPayload = `chromium-cdp-${s.port + 1}`;
    await expect(
      chromiumCdpBlueprint.factory(
        {},
        otherPayload as unknown as ReturnType<typeof resolveDevice>,
        { device }
      )
    ).rejects.toThrow(/disagrees with URN payload/);
  });
});
