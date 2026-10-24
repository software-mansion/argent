import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NativeDevtoolsApi, type NetworkEvent } from "../src/blueprints/native-devtools";
import {
  nativeNetworkLogsTool,
  summarizeRequests,
} from "../src/tools/native-devtools/native-network-logs";

vi.mock("../src/blueprints/native-devtools", async () => {
  const actual = await vi.importActual<typeof import("../src/blueprints/native-devtools")>(
    "../src/blueprints/native-devtools"
  );
  return { ...actual, precheckNativeDevtools: vi.fn(async () => null) };
});

const ev = (method: string, params: Record<string, unknown>): NetworkEvent => ({
  method,
  params,
  timestamp: 0,
});

const request = (id: string, url: string, t: number): NetworkEvent[] => [
  ev("Network.requestWillBeSent", {
    requestId: id,
    timestamp: t,
    request: { method: "GET", url },
  }),
  ev("Network.responseReceived", {
    requestId: id,
    response: { url, status: 200, mimeType: "application/json" },
  }),
  ev("Network.loadingFinished", { requestId: id, timestamp: t + 0.1, encodedDataLength: 10 }),
];

describe("native-network-logs request summary", () => {
  it("folds CDP events into one row per request", () => {
    const rows = summarizeRequests([
      ev("Network.requestWillBeSent", {
        requestId: "1",
        timestamp: 10,
        request: { method: "POST", url: "http://x/rpc/feed" },
      }),
      ev("Network.responseReceived", {
        requestId: "1",
        response: { url: "http://x/rpc/feed", status: 200, mimeType: "application/json" },
      }),
      ...Array.from({ length: 50 }, () =>
        ev("Network.dataReceived", { requestId: "1", dataLength: 1000 })
      ),
      ev("Network.loadingFinished", { requestId: "1", timestamp: 10.25, encodedDataLength: 50000 }),
      ev("Network.requestWillBeSent", {
        requestId: "2",
        timestamp: 11,
        request: { method: "GET", url: "http://x/down" },
      }),
      ev("Network.loadingFailed", {
        requestId: "2",
        timestamp: 11.5,
        errorText: "offline",
        encodedDataLength: 0,
      }),
    ]);
    expect(rows).toEqual([
      {
        requestId: "1",
        method: "POST",
        url: "http://x/rpc/feed",
        status: 200,
        mimeType: "application/json",
        bytes: 50000,
        durationMs: 250,
      },
      {
        requestId: "2",
        method: "GET",
        url: "http://x/down",
        error: "offline",
        bytes: 0,
        durationMs: 500,
      },
    ]);
  });

  it("keeps the requested url and adds finalUrl after a redirect", () => {
    const [row] = summarizeRequests([
      ev("Network.requestWillBeSent", {
        requestId: "1",
        request: { method: "GET", url: "http://x/api/me" },
      }),
      ev("Network.responseReceived", {
        requestId: "1",
        response: { url: "http://x/login", status: 200, mimeType: "text/html" },
      }),
    ]);
    expect(row).toEqual({
      requestId: "1",
      method: "GET",
      url: "http://x/api/me",
      finalUrl: "http://x/login",
      status: 200,
      mimeType: "text/html",
    });
  });

  it("sets neither url nor finalUrl when the request event is gone", () => {
    const [row] = summarizeRequests([
      ev("Network.responseReceived", {
        requestId: "1",
        response: { url: "http://x/login", status: 200, mimeType: "text/html" },
      }),
    ]);
    expect(row).toEqual({ requestId: "1", status: 200, mimeType: "text/html" });
  });

  it("does not treat a canonicalized url as a redirect", () => {
    const rows = summarizeRequests([
      ev("Network.requestWillBeSent", {
        requestId: "1",
        request: { method: "GET", url: "https://example.com" },
      }),
      ev("Network.responseReceived", {
        requestId: "1",
        response: { url: "https://example.com/", status: 200 },
      }),
      ev("Network.requestWillBeSent", {
        requestId: "2",
        request: { method: "GET", url: "http://LOCALHOST:8765/x" },
      }),
      ev("Network.responseReceived", {
        requestId: "2",
        response: { url: "http://localhost:8765/x", status: 200 },
      }),
    ]);
    expect(rows.map((r) => r.finalUrl)).toEqual([undefined, undefined]);
  });

  it("rounds fractional dylib timestamps to whole milliseconds", () => {
    const [row] = summarizeRequests([
      ev("Network.requestWillBeSent", {
        requestId: "1",
        timestamp: 1760000000.1,
        request: { method: "GET", url: "http://x/a" },
      }),
      ev("Network.loadingFinished", {
        requestId: "1",
        timestamp: 1760000000.35333,
        encodedDataLength: 1,
      }),
    ]);
    expect(row?.durationMs).toBe(253);
  });
});

describe("native-network-logs execute", () => {
  const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  const BUNDLE = "com.example.app";

  beforeEach(async () => {
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun"]);
  });

  const run = (
    log: NetworkEvent[],
    params: { limit?: number; format?: "requests" | "events"; clear?: boolean } = {},
    evicted = false
  ) => {
    const stored = [...log];
    const clearNetworkLog = vi.fn(() => {
      stored.length = 0;
    });
    const api = {
      isConnected: () => true,
      activateNetworkInspection: () => {},
      getNetworkLog: () => [...stored],
      clearNetworkLog,
      networkLogEvicted: () => evicted,
    } as unknown as NativeDevtoolsApi;
    const result = nativeNetworkLogsTool.execute(
      { nativeDevtools: api },
      {
        udid: UDID,
        bundleId: BUNDLE,
        limit: params.limit ?? 50,
        clear: params.clear ?? false,
        format: params.format,
      }
    );
    return { result: result as Promise<Record<string, any>>, clearNetworkLog };
  };

  const log = [
    ...request("a", "http://x/a", 1),
    ...request("b", "http://x/b", 2),
    ...request("c", "http://x/c", 3),
  ];

  it("returns request rows by default", async () => {
    const out = await run(log).result;
    expect(out.events).toBeUndefined();
    expect(out.requests.map((r: { url: string }) => r.url)).toEqual([
      "http://x/a",
      "http://x/b",
      "http://x/c",
    ]);
    expect(out).toMatchObject({ status: "ok", count: 3, totalRequests: 3 });
    expect(out.truncated).toBeUndefined();
  });

  it("returns raw events with format events", async () => {
    const out = await run(log, { format: "events", limit: 2 }).result;
    expect(out.requests).toBeUndefined();
    expect(out).toMatchObject({ status: "ok", count: 2, events: log.slice(-2) });
  });

  it("limits to the most recent requests and still counts them all", async () => {
    const out = await run(log, { limit: 1 }).result;
    expect(out).toMatchObject({ count: 1, totalRequests: 3 });
    expect(out.requests[0].url).toBe("http://x/c");
  });

  it("clears the log only when asked", async () => {
    const kept = run(log);
    await kept.result;
    expect(kept.clearNetworkLog).not.toHaveBeenCalled();
    const cleared = run(log, { clear: true });
    expect((await cleared.result).count).toBe(3);
    expect(cleared.clearNetworkLog).toHaveBeenCalledWith(BUNDLE);
  });

  it("returns no rows for limit 0 but still counts them", async () => {
    expect(await run(log, { limit: 0 }).result).toMatchObject({
      count: 0,
      totalRequests: 3,
      requests: [],
    });
    expect((await run(log, { limit: 0, format: "events" }).result).events).toEqual([]);
  });

  it("rejects a negative or fractional limit", () => {
    const base = { udid: UDID, bundleId: BUNDLE };
    const schema = nativeNetworkLogsTool.zodSchema!;
    expect(schema.safeParse({ ...base, limit: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 1.5 }).success).toBe(false);
  });

  it("flags a log only once it evicted events", async () => {
    expect((await run(log, {}, true).result).truncated).toBe(true);
    expect((await run(log, {}, false).result).truncated).toBeUndefined();
  });
});
