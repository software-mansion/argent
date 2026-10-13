import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MAX_NETWORK_LOG_ENTRIES,
  type NativeDevtoolsApi,
  type NetworkEvent,
} from "../src/blueprints/native-devtools";
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

  it("does not take the response url as url when the request event is gone", () => {
    const [row] = summarizeRequests([
      ev("Network.responseReceived", {
        requestId: "1",
        response: { url: "http://x/login", status: 200, mimeType: "text/html" },
      }),
    ]);
    expect(row?.url).toBeUndefined();
    expect(row?.finalUrl).toBe("http://x/login");
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
    params: { limit?: number; format?: "requests" | "events"; clear?: boolean } = {}
  ) => {
    const clearNetworkLog = vi.fn();
    const api = {
      isConnected: () => true,
      activateNetworkInspection: () => {},
      getNetworkLog: () => log,
      clearNetworkLog,
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
    await cleared.result;
    expect(cleared.clearNetworkLog).toHaveBeenCalledWith(BUNDLE);
  });

  it("flags a log that reached its size limit", async () => {
    const full = Array.from({ length: MAX_NETWORK_LOG_ENTRIES }, () =>
      ev("Network.dataReceived", { requestId: "a", dataLength: 1 })
    );
    expect((await run(full).result).truncated).toBe(true);
    expect((await run(full.slice(1)).result).truncated).toBeUndefined();
  });
});
