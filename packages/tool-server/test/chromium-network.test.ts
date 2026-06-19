import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import { createNetworkManager, type NetworkManager } from "../src/chromium-server/network";

// A fake CDP client: a real event bus (so the manager's `event` listener fires)
// plus a `send` spy that records commands.
function fakeCdp() {
  const events = new TypedEventEmitter<{
    event: (m: string, p: Record<string, unknown>) => void;
  }>();
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}) as unknown);
  return { events, send, cdp: { events, send } as never };
}

function emitRequest(
  events: { emit: (e: "event", m: string, p: Record<string, unknown>) => void },
  o: {
    id: string;
    method?: string;
    url: string;
    type?: string;
    status?: number;
    finished?: boolean;
    failed?: string;
  }
) {
  events.emit("event", "Network.requestWillBeSent", {
    requestId: o.id,
    request: { method: o.method ?? "GET", url: o.url, headers: { "x-test": "1" } },
    type: o.type ?? "XHR",
    timestamp: 100,
    wallTime: 1_700_000_000,
  });
  if (o.status != null) {
    events.emit("event", "Network.responseReceived", {
      requestId: o.id,
      type: o.type ?? "XHR",
      response: {
        status: o.status,
        statusText: "OK",
        mimeType: "application/json",
        headers: { "content-type": "application/json", "authorization": "secret" },
      },
    });
  }
  if (o.finished) {
    events.emit("event", "Network.loadingFinished", {
      requestId: o.id,
      timestamp: 100.25,
      encodedDataLength: 1234,
    });
  }
  if (o.failed) {
    events.emit("event", "Network.loadingFailed", { requestId: o.id, errorText: o.failed });
  }
}

describe("NetworkManager (recording)", () => {
  let f: ReturnType<typeof fakeCdp>;
  let net: NetworkManager;

  beforeEach(() => {
    f = fakeCdp();
    net = createNetworkManager({ cdp: f.cdp });
  });

  it("records requests with method/url/status/type/headers and duration, oldest-first", () => {
    emitRequest(f.events, {
      id: "1",
      method: "GET",
      url: "https://x.test/a",
      status: 200,
      finished: true,
    });
    emitRequest(f.events, {
      id: "2",
      method: "POST",
      url: "https://x.test/b",
      status: 201,
      finished: true,
    });
    const reqs = net.requests();
    expect(reqs.map((r) => r.requestId)).toEqual(["1", "2"]);
    expect(reqs[0]).toMatchObject({
      method: "GET",
      url: "https://x.test/a",
      status: 200,
      resourceType: "XHR",
      mimeType: "application/json",
      encodedDataLength: 1234,
    });
    expect(reqs[0]!.durationMs).toBeCloseTo(250, 0);
    expect(reqs[0]!.requestHeaders).toEqual({ "x-test": "1" });
  });

  it("merges on-the-wire headers from the *ExtraInfo events (Authorization etc.)", () => {
    f.events.emit("event", "Network.requestWillBeSent", {
      requestId: "1",
      request: { method: "GET", url: "https://x.test/", headers: { "x-base": "1" } },
      type: "Fetch",
      timestamp: 1,
    });
    f.events.emit("event", "Network.requestWillBeSentExtraInfo", {
      requestId: "1",
      headers: { "authorization": "Bearer secret", "x-extra": "2" },
    });
    f.events.emit("event", "Network.responseReceivedExtraInfo", {
      requestId: "1",
      headers: { "set-cookie": "sid=abc" },
    });
    const rec = net.get("1")!;
    expect(rec.requestHeaders).toMatchObject({
      "x-base": "1",
      "authorization": "Bearer secret",
      "x-extra": "2",
    });
    expect(rec.responseHeaders).toMatchObject({ "set-cookie": "sid=abc" });
  });

  it("get() looks up a single record by requestId", () => {
    emitRequest(f.events, { id: "abc", url: "https://x.test/", status: 200 });
    expect(net.get("abc")?.url).toBe("https://x.test/");
    expect(net.get("missing")).toBeUndefined();
  });

  it("marks failed requests", () => {
    emitRequest(f.events, { id: "1", url: "https://x.test/boom", failed: "net::ERR_FAILED" });
    expect(net.get("1")).toMatchObject({ failed: true, errorText: "net::ERR_FAILED" });
  });

  it("reattach enables the Network domain; dispose disables it and detaches", async () => {
    await net.reattach();
    expect(f.send).toHaveBeenCalledWith("Network.enable");
    net.dispose();
    expect(f.send).toHaveBeenCalledWith("Network.disable");
    // After dispose, further events are ignored.
    emitRequest(f.events, { id: "late", url: "https://x.test/late", status: 200 });
    expect(net.get("late")).toBeUndefined();
  });
});

// ── view-network-logs / view-network-request-details: Chromium branch ────────
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { assertSupported } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import type { NetworkRequestRecord } from "../src/chromium-server/network";

const rec = (
  over: Partial<NetworkRequestRecord> & { requestId: string }
): NetworkRequestRecord => ({
  method: "GET",
  url: "https://x.test/",
  startedDateTime: "",
  startTs: 0,
  ...over,
});

describe("view-network-logs (chromium branch)", () => {
  it("capability now admits chromium as well as iOS/Android", () => {
    expect(() =>
      assertSupported(
        "view-network-logs",
        networkLogsTool.capability,
        resolveDevice("chromium-cdp-9222")
      )
    ).not.toThrow();
    expect(() =>
      assertSupported(
        "view-network-logs",
        networkLogsTool.capability,
        resolveDevice("emulator-5554")
      )
    ).not.toThrow();
  });

  it("services() routes a chromium device to the chromium CDP ref", () => {
    const svc = networkLogsTool.services!({
      device_id: "chromium-cdp-9222",
      port: 8081,
      pageIndex: "latest",
    });
    expect(Object.keys(svc)).toEqual(["chromium"]);
  });

  it("renders captured chromium requests in the shared paginated format", async () => {
    const requests = [
      rec({
        requestId: "1",
        method: "GET",
        url: "https://x.test/a",
        status: 200,
        statusText: "OK",
      }),
      rec({
        requestId: "2",
        method: "POST",
        url: "https://x.test/api",
        status: 500,
        statusText: "Err",
      }),
    ];
    const services = { chromium: { server: { network: { requests: () => requests } } } } as never;
    const out = (await networkLogsTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      pageIndex: "latest",
    })) as string;
    expect(out).toContain("=== NETWORK LOGS (page 1/1, 2 total) ===");
    expect(out).toContain('{id: 1} "GET /a" 200 OK');
    expect(out).toContain('{id: 2} "POST /api" 500 Err');
  });

  it("reports no-traffic when the recording is empty", async () => {
    const services = { chromium: { server: { network: { requests: () => [] } } } } as never;
    const out = (await networkLogsTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      pageIndex: "latest",
    })) as string;
    expect(out).toMatch(/No network traffic captured/);
  });
});

describe("view-network-request-details (chromium branch)", () => {
  it("returns redacted details + body via Network.getResponseBody", async () => {
    const record = rec({
      requestId: "r1",
      method: "POST",
      url: "https://x.test/api",
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      requestHeaders: { "authorization": "Bearer secret", "x-ok": "1" },
      responseHeaders: { "set-cookie": "sid=abc", "content-type": "application/json" },
    });
    const send = vi.fn(async () => ({ body: '{"ok":true}', base64Encoded: false }));
    const services = {
      chromium: { cdp: { send }, server: { network: { get: () => record } } },
    } as never;

    const details = (await networkRequestTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      requestId: "r1",
      includeBody: true,
    })) as {
      request: { headers: Record<string, string> };
      response: { headers: Record<string, string>; body?: string };
    };

    expect(send).toHaveBeenCalledWith("Network.getResponseBody", { requestId: "r1" });
    expect(details.request.headers.authorization).toBe("[REDACTED]");
    expect(details.request.headers["x-ok"]).toBe("1");
    expect(details.response.headers["set-cookie"]).toBe("[REDACTED]");
    expect(details.response.body).toBe('{"ok":true}');
  });

  it("returns an error string when the requestId is unknown", async () => {
    const services = {
      chromium: { cdp: { send: vi.fn() }, server: { network: { get: () => undefined } } },
    } as never;
    const out = await networkRequestTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      requestId: "nope",
      includeBody: true,
    });
    expect(out).toMatch(/not found/);
  });
});
