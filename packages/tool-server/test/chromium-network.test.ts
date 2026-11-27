import type { ToolContext } from "@argent/registry";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import { createNetworkManager, type NetworkManager } from "../src/chromium-server/network";
import { toCdpNetworkConditions } from "../src/utils/network-conditions";

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

  it("reports throttled only while the stored conditions shape traffic", async () => {
    expect(net.throttled()).toBe(false);
    await net.setConditions(toCdpNetworkConditions({ latencyMs: 300 }));
    expect(net.throttled()).toBe(true);
    await net.setConditions(toCdpNetworkConditions({ offline: true }));
    expect(net.throttled()).toBe(true);
    await net.setConditions(toCdpNetworkConditions({ downloadKbps: 500 }));
    expect(net.throttled()).toBe(true);
    await net.setConditions(toCdpNetworkConditions(null));
    expect(net.throttled()).toBe(false);
  });

  it("marks a record finished once Network.loadingFinished arrives, not at its response", () => {
    emitRequest(f.events, { id: "open", url: "https://x.test/open", status: 200 });
    emitRequest(f.events, { id: "failed", url: "https://x.test/boom", failed: "net::ERR_FAILED" });
    emitRequest(f.events, { id: "done", url: "https://x.test/done", finished: true });

    expect(net.get("open")?.finished).toBeUndefined();
    expect(net.get("failed")?.finished).toBeUndefined();
    expect(net.get("done")?.finished).toBe(true);
  });

  it("times a no-store fetch that ends at the last byte of its declared body like its loadingFinished", () => {
    emitRequest(f.events, { id: "unread", url: "https://x.test/unread", type: "Fetch" });
    f.events.emit("event", "Network.responseReceived", {
      requestId: "unread",
      type: "Fetch",
      response: { status: 200, headers: { "Cache-Control": "no-store", "Content-Length": "58" } },
    });
    f.events.emit("event", "Network.dataReceived", {
      requestId: "unread",
      dataLength: 30,
      timestamp: 100.1,
    });
    f.events.emit("event", "Network.dataReceived", {
      requestId: "unread",
      dataLength: 28,
      timestamp: 100.2,
    });
    expect(net.get("unread")).toMatchObject({ finished: true });
    expect(net.get("unread")?.durationMs).toBeCloseTo(200);
  });

  it("numbers the records in creation order, and requestsAfter lists the ones after a number", () => {
    emitRequest(f.events, { id: "a", url: "https://x.test/a" });
    emitRequest(f.events, { id: "b", url: "https://x.test/b" });
    // A later event of a record keeps its number.
    emitRequest(f.events, { id: "a", url: "https://x.test/a", status: 200, finished: true });

    const after = (n: number) =>
      net.requestsAfter(n).map(({ seq, record }) => `${seq}:${record.requestId}`);
    expect(after(0)).toEqual(["1:a", "2:b"]);
    expect(after(1)).toEqual(["2:b"]);
    expect(net.requestsAfter(0)[0]!.record).toBe(net.get("a"));
  });

  it("marks where a capture starts and where its stop ends, and keeps the mark after the stop", () => {
    // No mark before a start, and a stop without a start marks nothing.
    emitRequest(f.events, { id: "before", url: "https://x.test/before" });
    expect(net.stopCapture()).toBeUndefined();
    expect(net.captureMark()).toBeUndefined();

    expect(net.startCapture()).toEqual({ lastSeq: 1 });
    emitRequest(f.events, { id: "during", url: "https://x.test/during" });
    expect(net.stopCapture()).toEqual({ lastSeq: 1, stoppedSeq: 2 });
    emitRequest(f.events, { id: "after", url: "https://x.test/after" });
    // A second stop keeps where the first one ended.
    expect(net.stopCapture()).toEqual({ lastSeq: 1, stoppedSeq: 2 });
    expect(net.captureMark()).toEqual({ lastSeq: 1, stoppedSeq: 2 });

    // A new start begins a new mark, without an end.
    expect(net.startCapture()).toEqual({ lastSeq: 3 });
    expect(net.captureMark()).toEqual({ lastSeq: 3 });
  });

  it("drops an evicted record's number, so requestsAfter never lists it", () => {
    // The store keeps 1000 records.
    for (let i = 1; i <= 1001; i++) {
      emitRequest(f.events, { id: `r${i}`, url: `https://x.test/${i}` });
    }

    const kept = net.requestsAfter(0);
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toMatchObject({ seq: 2, record: { requestId: "r2" } });
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

  it("reads pageIndex null as the latest page, like an omitted pageIndex", async () => {
    const requests = Array.from({ length: 60 }, (_, i) =>
      rec({ requestId: String(i + 1), url: `https://x.test/r${i + 1}`, status: 200 })
    );
    const services = { chromium: { server: { network: { requests: () => requests } } } } as never;
    const render = async (pageIndex: unknown) => {
      const params = networkLogsTool.zodSchema!.parse({
        device_id: "chromium-cdp-9222",
        port: 8081,
        pageIndex,
      });
      return (await networkLogsTool.execute(
        services,
        params as Parameters<typeof networkLogsTool.execute>[1]
      )) as string;
    };
    expect(await render(null)).toContain("=== NETWORK LOGS (page 2/2, 60 total) ===");
    expect(await render(undefined)).toContain("=== NETWORK LOGS (page 2/2, 60 total) ===");
    expect(await render(0)).toContain("=== NETWORK LOGS (page 1/2, 60 total) ===");
    expect(await render("1")).toContain("=== NETWORK LOGS (page 2/2, 60 total) ===");
  });

  it("reports no-traffic when the recording is empty", async () => {
    const services = { chromium: { server: { network: { requests: () => [] } } } } as never;
    const out = (await networkLogsTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      pageIndex: "latest",
    })) as string;
    expect(out).toMatch(/No network traffic captured/);
    expect(out).not.toContain("\u2014");
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

  it.each([
    {
      kind: "a PNG",
      mimeType: "image/png",
      bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a],
      omitted: true,
    },
    {
      kind: "octet-stream",
      mimeType: "application/octet-stream",
      bytes: [0, 1, 2, 0xff, 0xfe],
      omitted: true,
    },
    { kind: "UTF-8 text", mimeType: "text/plain", bytes: [...Buffer.from("café")], omitted: false },
  ])("returns $kind body sent as base64 as text only when it is UTF-8", async (c) => {
    const record = rec({
      requestId: "r3",
      url: "https://x.test/b",
      status: 200,
      mimeType: c.mimeType,
    });
    const body = Buffer.from(c.bytes).toString("base64");
    const send = vi.fn(async () => ({ body, base64Encoded: true }));
    const services = {
      chromium: { cdp: { send }, server: { network: { get: () => record } } },
    } as never;

    const details = (await networkRequestTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      requestId: "r3",
      includeBody: true,
    })) as { response: { body?: string } };

    expect(details.response.body).toBe(
      c.omitted ? `[body omitted: binary ${c.mimeType}, ${c.bytes.length} bytes]` : "café"
    );
  });

  it.each([
    { size: 1000, cut: false, returns: "whole, as it is at the 1000-char limit" },
    { size: 1001, cut: true, returns: "cut to 1000 chars with its size, one char past the limit" },
  ])("returns a request body of $size chars $returns", async ({ size, cut }) => {
    const postData = "p".repeat(size);
    const record = rec({ requestId: "r2", method: "POST", url: "https://x.test/api", postData });
    const services = {
      chromium: { cdp: { send: vi.fn() }, server: { network: { get: () => record } } },
    } as never;

    const details = (await networkRequestTool.execute(services, {
      device_id: "chromium-cdp-9222",
      port: 8081,
      requestId: "r2",
      includeBody: true,
    })) as { request: { postData?: string } };

    if (cut) {
      expect(details.request.postData).toBe(
        `[TRUNCATED: first 1000 chars shown, full size: ${size} chars]\n${"p".repeat(1000)}...`
      );
    } else {
      expect(details.request.postData).toBe(postData);
    }
  });

  it.each([
    { kind: "every byte of it arrived", finished: true, body: '{"ok":true}' },
    { kind: "some of it is still due", finished: false, body: undefined },
  ])(
    "reads a body Chrome keeps no copy of yet from its buffer only when $kind",
    async ({ finished, body }) => {
      // A no-store fetch() the page has not read: Chrome has the bytes but no body to give.
      const record = rec({ requestId: "r4", status: 200, mimeType: "application/json", finished });
      const send = vi.fn(async (method: string) => {
        if (method === "Network.streamResourceContent") {
          return { bufferedData: Buffer.from('{"ok":true}').toString("base64") };
        }
        throw new Error("No data found for resource with given identifier");
      });
      const services = {
        chromium: { cdp: { send }, server: { network: { get: () => record } } },
      } as never;

      const details = (await networkRequestTool.execute(services, {
        device_id: "chromium-cdp-9222",
        port: 8081,
        requestId: "r4",
        includeBody: true,
      })) as { response: { body?: string } };

      expect(details.response.body).toBe(body);
    }
  );

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

  it.each(["false", "0", "true"])("rejects a string includeBody %j", (value) => {
    const result = networkRequestTool.zodSchema!.safeParse({
      device_id: "chromium-cdp-9222",
      requestId: "r1",
      includeBody: value,
    });

    expect(result.error?.issues).toMatchObject([{ code: "invalid_type", path: ["includeBody"] }]);
  });

  it.each([true, false])("accepts a boolean includeBody %j", (value) => {
    const result = networkRequestTool.zodSchema!.safeParse({
      device_id: "chromium-cdp-9222",
      requestId: "r1",
      includeBody: value,
    });

    expect(result.success).toBe(true);
    expect(result.data?.includeBody).toBe(value);
  });
});

describe("secret values on the Chromium branch", () => {
  const clientSecrets = new Map([
    ["TOKEN", "stored-token-0123456789"],
    ["PIN", "4821"],
  ]);

  it("view-network-logs redacts the path and the error, and keeps the id and the duration", async () => {
    const requests = [
      rec({
        requestId: "4821",
        method: "GET",
        url: "https://x.test/v1/stored-token-0123456789/profile",
        status: 200,
        statusText: "OK",
        encodedDataLength: 4821,
        durationMs: 4821,
      }),
      rec({
        requestId: "2",
        url: "https://x.test/pin/4821",
        failed: true,
        errorText: "net::ERR_FAILED stored-token-0123456789",
      }),
    ];
    const services = { chromium: { server: { network: { requests: () => requests } } } } as never;
    const out = (await networkLogsTool.execute(
      services,
      { device_id: "chromium-cdp-9222", port: 8081, pageIndex: "latest" },
      { artifacts: {}, clientSecrets } as unknown as ToolContext
    )) as string;
    expect(out).toContain('{id: 4821} "GET /v1/{{secret:TOKEN}}/profile" 200 OK');
    expect(out).toContain("4821 ms");
    expect(out).toContain('"GET /pin/{{secret:PIN}}" net::ERR_FAILED {{secret:TOKEN}}');
    expect(out).not.toContain("stored-token");
  });

  it("view-network-request-details redacts a copy, so the record's initiator keeps its URL", async () => {
    const record = rec({
      requestId: "4821",
      method: "POST",
      url: "https://x.test/api?t=stored-token-0123456789",
      status: 200,
      mimeType: "application/json",
      postData: '{"pin":"4821","count":14821}',
      initiator: { type: "script", url: "https://x.test/app.js?t=stored-token-0123456789" },
    });
    const send = vi.fn(async () => ({ body: '{"pin":"4821"}', base64Encoded: false }));
    const services = {
      chromium: { cdp: { send }, server: { network: { get: () => record } } },
    } as never;

    const details = (await networkRequestTool.execute(
      services,
      { device_id: "chromium-cdp-9222", port: 8081, requestId: "4821", includeBody: true },
      { artifacts: {}, clientSecrets } as unknown as ToolContext
    )) as {
      requestId: string;
      initiator: { url: string };
      request: { url: string; postData: string };
      response: { body: string };
    };

    expect(details.requestId).toBe("4821");
    expect(details.request.url).toBe("https://x.test/api?t={{secret:TOKEN}}");
    expect(details.request.postData).toBe('{"pin":"{{secret:PIN}}","count":14821}');
    expect(details.response.body).toBe('{"pin":"{{secret:PIN}}"}');
    expect(details.initiator.url).toBe("https://x.test/app.js?t={{secret:TOKEN}}");
    expect(record.initiator?.url).toBe("https://x.test/app.js?t=stored-token-0123456789");
  });
});
