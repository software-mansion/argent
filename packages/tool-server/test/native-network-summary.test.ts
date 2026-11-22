import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NativeDevtoolsApi, type NetworkEvent } from "../src/blueprints/native-devtools";
import { Registry } from "@argent/registry";
import recordedIosEvents from "./fixtures/native-network-events-ios.json";
import {
  createNativeNetworkLogsTool,
  summarizeRequests,
} from "../src/tools/native-devtools/native-network-logs";

const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

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
      ev("Network.loadingFinished", {
        requestId: "1",
        encodedDataLength: 50000,
        nativeDevtoolsDurationMs: 250.2,
      }),
      ev("Network.requestWillBeSent", {
        requestId: "2",
        timestamp: 11,
        request: { method: "GET", url: "http://x/down" },
      }),
      ev("Network.loadingFailed", {
        requestId: "2",
        errorText: "offline",
        encodedDataLength: 0,
        nativeDevtoolsDurationMs: 499.6,
      }),
    ]);
    expect(rows).toEqual([
      {
        id: "1",
        state: "complete",
        method: "POST",
        url: "http://x/rpc/feed",
        status: 200,
        mimeType: "application/json",
        durationMs: 250,
      },
      {
        id: "2",
        state: "failed",
        method: "GET",
        url: "http://x/down",
        errorText: "offline",
        durationMs: 500,
      },
    ]);
  });

  it("folds events recorded from the iOS dylib on a simulator", () => {
    expect(summarizeRequests(recordedIosEvents)).toEqual([
      {
        id: "420318B5-F43B-4877-8EDE-C1BED61CAF5A",
        state: "complete",
        method: "GET",
        url: "http://127.0.0.1:4210/ok?n=first",
        status: 200,
        mimeType: "application/json",
        durationMs: 15,
      },
      {
        id: "7AB9EAA8-079A-414E-B16F-22BD7F56819C",
        state: "complete",
        method: "GET",
        url: "http://127.0.0.1:4210/missing",
        status: 404,
        mimeType: "application/json",
        durationMs: 18,
      },
      {
        id: "1B65117A-383D-42F6-8ABA-8090BD1863E2",
        state: "failed",
        method: "GET",
        url: "http://127.0.0.1:4249/refused",
        errorText: "Could not connect to the server.",
        durationMs: 19,
      },
      {
        id: "2D5BAA19-DADD-472B-92C1-104D5A149635",
        state: "complete",
        method: "GET",
        url: "http://127.0.0.1:4210/redirect",
        status: 200,
        mimeType: "application/json",
        durationMs: 19,
      },
    ]);
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

  const run = (log: NetworkEvent[], params: { limit?: number; clear?: boolean } = {}) => {
    const stored = [...log];
    const clearNetworkLog = vi.fn(() => {
      stored.length = 0;
    });
    const api = {
      isConnected: () => true,
      activateNetworkInspection: () => {},
      getNetworkLog: () => [...stored],
      clearNetworkLog,
    } as unknown as NativeDevtoolsApi;
    const result = nativeNetworkLogsTool.execute(
      { nativeDevtools: api },
      {
        udid: UDID,
        bundleId: BUNDLE,
        limit: params.limit ?? 50,
        clear: params.clear ?? false,
      }
    );
    return { result: result as Promise<Record<string, any>>, clearNetworkLog };
  };

  const log = [
    ...request("a", "http://x/a", 1),
    ...request("b", "http://x/b", 2),
    ...request("c", "http://x/c", 3),
  ];

  it("returns one row per request", async () => {
    const out = await run(log).result;
    expect(out.events).toBeUndefined();
    expect(out.requests.map((r: { url: string }) => r.url)).toEqual([
      "http://x/a",
      "http://x/b",
      "http://x/c",
    ]);
    expect(out).toMatchObject({ status: "ok", count: 3, total: 3 });
  });

  it("limits to the most recent requests and still counts them all", async () => {
    const out = await run(log, { limit: 1 }).result;
    expect(out).toMatchObject({ count: 1, total: 3 });
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

  it("orders overlapping requests by when they started", async () => {
    const [startA, responseA, finishA] = request("a", "http://x/a", 1);
    const [startB, responseB, finishB] = request("b", "http://x/b", 2);
    const overlapping = [startA, startB, responseB, finishB, responseA, finishA];
    const all = await run(overlapping).result;
    expect(all.requests.map((r: { url: string }) => r.url)).toEqual(["http://x/a", "http://x/b"]);
    const latest = await run(overlapping, { limit: 1 }).result;
    expect(latest.requests.map((r: { url: string }) => r.url)).toEqual(["http://x/b"]);
  });

  it("returns every request for limit 0", async () => {
    expect(await run(log, { limit: 0 }).result).toMatchObject({ count: 3, total: 3 });
  });
});
