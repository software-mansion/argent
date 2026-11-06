import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  IOS_NATIVE_REQUEST_ID,
  createIosNetworkRecords,
  findIosNativeRecord,
  liveIosNetworkCaptureDevices,
  liveIosNetworkCaptures,
  registerIosNetworkCaptures,
  type ClosedConnectionCheck,
  type IosNetworkRecordStore,
} from "../src/blueprints/ios-network-records";
import { rememberDeviceAlias, resetDeviceAliases } from "../src/utils/debugger/device-alias";
import {
  MAX_RECORDS,
  NOT_RECONNECTED,
  PROCESS_ENDED,
  RECORD_CHARS_BUDGET,
  recordSize,
} from "../src/utils/native-network-record";

const CONN = 1;
const OTHER_CONN = 2;
const UDID = "5A1B2C3D-0000-4000-8000-00000000AAAA";
const BUNDLE = "com.example.demo";
/** Seconds since the epoch, as the agent sends it. */
const WALL_TIME = 1_762_430_000.1236;
const LARGE_VALUE = "v".repeat(60 * 1024);
/** Under the per-value and per-map caps, so a record keeps every one of them whole. */
const LARGE_HEADERS = {
  "x-h0": LARGE_VALUE,
  "x-h1": LARGE_VALUE,
  "x-h2": LARGE_VALUE,
  "x-h3": LARGE_VALUE,
};

const unregisters: Array<() => void> = [];

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  resetDeviceAliases();
  vi.restoreAllMocks();
});

function newStore(): IosNetworkRecordStore {
  return createIosNetworkRecords(() => ({ armed: true }));
}

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  wallTime?: number;
  redirectResponse?: unknown;
}

interface ResponseInit {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  mimeType?: string;
  type?: string;
}

/** Sends `Network.*` events in the shapes the agent uses, on one connection. */
function agentOn(store: IosNetworkRecordStore, connection = CONN) {
  let clock = 81_234.5;
  const tick = (): number => (clock += 0.01);
  return {
    requestWillBeSent(requestId: string, url: string, init: RequestInit = {}): void {
      const request: Record<string, unknown> = {
        url,
        method: init.method ?? "GET",
        headers: init.headers ?? { Accept: "*/*" },
      };
      if (init.hasPostData) request.hasPostData = true;
      else request.postData = init.postData ?? "";
      store.fold(connection, "Network.requestWillBeSent", {
        requestId,
        loaderId: requestId,
        documentURL: url,
        timestamp: tick(),
        wallTime: init.wallTime ?? WALL_TIME,
        request,
        initiator: { type: "other" },
        type: "XHR",
        frameId: "1",
        ...(init.redirectResponse !== undefined ? { redirectResponse: init.redirectResponse } : {}),
      });
    },
    responseReceived(requestId: string, url: string, init: ResponseInit = {}): void {
      store.fold(connection, "Network.responseReceived", {
        requestId,
        timestamp: tick(),
        type: init.type ?? "XHR",
        response: {
          url: init.url ?? url,
          status: init.status ?? 200,
          statusText: init.statusText ?? "no error",
          headers: init.headers ?? { "Content-Type": "application/json" },
          mimeType: init.mimeType ?? "application/json",
          encodedDataLength: -1,
        },
      });
    },
    dataReceived(requestId: string, dataLength: number): void {
      store.fold(connection, "Network.dataReceived", {
        requestId,
        timestamp: tick(),
        dataLength,
        encodedDataLength: dataLength,
      });
    },
    loadingFinished(requestId: string, encodedDataLength: number, durationMs?: number): void {
      store.fold(connection, "Network.loadingFinished", {
        requestId,
        timestamp: tick(),
        encodedDataLength,
        ...(durationMs !== undefined ? { nativeDevtoolsDurationMs: durationMs } : {}),
      });
    },
    loadingFailed(requestId: string, errorText: string, durationMs?: number): void {
      store.fold(connection, "Network.loadingFailed", {
        requestId,
        timestamp: tick(),
        errorText,
        type: "XHR",
        canceled: false,
        encodedDataLength: 0,
        ...(durationMs !== undefined ? { nativeDevtoolsDurationMs: durationMs } : {}),
      });
    },
    /** A request with a response and its end, in one go. */
    complete(requestId: string, url: string): void {
      this.requestWillBeSent(requestId, url);
      this.responseReceived(requestId, url);
      this.dataReceived(requestId, 2);
      this.loadingFinished(requestId, 2, 5);
    },
  };
}

function idOf(store: IosNetworkRecordStore, layerId: string, port = 8081): string {
  const record = store.records(port).find((r) => r.layerId === layerId);
  if (!record) throw new Error(`no listed record for ${layerId}`);
  return record.id;
}

describe("iOS native network records: folding", () => {
  it("folds a full event stream into one complete record", () => {
    const store = newStore();
    const agent = agentOn(store);
    const rid = randomUUID();

    agent.requestWillBeSent(rid, "https://api.example.com/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App": "demo" },
      postData: '{"a":1}',
    });
    agent.responseReceived(rid, "https://api.example.com/start", {
      url: "https://api.example.com/final",
      statusText: "no error",
      headers: { "Content-Type": "application/json", "Content-Length": "4" },
    });
    agent.dataReceived(rid, 2);
    agent.dataReceived(rid, 2);
    agent.loadingFinished(rid, 4, 87.6);

    const records = store.records(8081);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      id: expect.stringMatching(IOS_NATIVE_REQUEST_ID),
      layer: "ios-native",
      layerId: rid,
      connection: CONN,
      state: "complete",
      request: {
        url: "https://api.example.com/start",
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App": "demo" },
        hasPostData: true,
      },
      response: {
        url: "https://api.example.com/final",
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json", "Content-Length": "4" },
        mimeType: "application/json",
      },
      resourceType: "XHR",
      encodedDataLength: 4,
      timing: { startedAt: 1_762_430_000_124, durationMs: 88 },
    });
    expect(store.record(records[0]!.id)).toBe(records[0]);
  });

  it("replaces the agent's status text with the standard reason phrase", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.requestWillBeSent("missing", "https://cdn.example.com/missing.png");
    agent.responseReceived("missing", "https://cdn.example.com/missing.png", {
      status: 404,
      statusText: "not found",
      mimeType: "image/png",
      type: "Image",
    });
    agent.requestWillBeSent("odd", "https://api.example.com/odd");
    agent.responseReceived("odd", "https://api.example.com/odd", {
      status: 599,
      statusText: "server error",
    });

    const [missing, odd] = store.records(8081);
    expect(missing).toMatchObject({
      state: "headers",
      response: { status: 404, statusText: "Not Found", mimeType: "image/png" },
      resourceType: "Image",
    });
    // A status without a standard phrase gets none, not the agent's.
    expect(odd!.response).toMatchObject({ status: 599, statusText: "" });
  });

  it("marks a request as having a body only when it streams one or sends post data", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.requestWillBeSent("empty", "https://api.example.com/a", { postData: "" });
    agent.requestWillBeSent("streamed", "https://api.example.com/b", {
      method: "PUT",
      hasPostData: true,
    });
    agent.requestWillBeSent("posted", "https://api.example.com/c", {
      method: "POST",
      postData: "x=1",
    });

    const [empty, streamed, posted] = store.records(8081);
    expect(empty!.request).not.toHaveProperty("hasPostData");
    expect(streamed!.request.hasPostData).toBe(true);
    expect(posted!.request.hasPostData).toBe(true);
  });

  it("fails a request with the agent's error text and measured duration", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.requestWillBeSent("offline", "https://api.example.com/offline");
    agent.loadingFailed("offline", "The Internet connection appears to be offline.", 12.4);
    agent.requestWillBeSent("silent", "https://api.example.com/silent");
    agent.loadingFailed("silent", "", 3);

    const [offline, silent] = store.records(8081);
    expect(offline).toMatchObject({
      state: "failed",
      errorText: "The Internet connection appears to be offline.",
      timing: { startedAt: 1_762_430_000_124, durationMs: 12 },
    });
    expect(offline!.response).toBeUndefined();
    expect(silent).toMatchObject({ state: "failed", errorText: "Unknown error" });
  });

  it("times a request from the arrival of its events when the app measured no duration", () => {
    const store = newStore();
    const agent = agentOn(store);
    const now = vi.spyOn(performance, "now");

    now.mockReturnValueOnce(1_000);
    agent.requestWillBeSent("unmeasured", "https://api.example.com/a");
    now.mockReturnValueOnce(1_250.4);
    agent.loadingFinished("unmeasured", 0);

    now.mockReturnValueOnce(2_000);
    agent.requestWillBeSent("negative", "https://api.example.com/b");
    now.mockReturnValueOnce(2_030);
    agent.loadingFailed("negative", "timed out", -1);

    const [unmeasured, negative] = store.records(8081);
    expect(unmeasured!.timing.durationMs).toBe(250);
    expect(negative!.timing.durationMs).toBe(30);
  });

  it("dates a request from its timestamp when the agent sent no wall time", () => {
    const store = newStore();
    store.fold(CONN, "Network.requestWillBeSent", {
      requestId: "no-wall-time",
      timestamp: 81_234.5678,
      request: { url: "https://api.example.com/a", method: "GET", headers: {} },
    });
    expect(store.records(8081)[0]!.timing.startedAt).toBe(81_234_568);
  });

  it("opens no second record for a redirect hop of the same request", () => {
    const store = newStore();
    const agent = agentOn(store);
    const rid = randomUUID();

    agent.requestWillBeSent(rid, "http://example.com/old");
    agent.requestWillBeSent(rid, "https://example.com/new", {
      redirectResponse: {
        url: "http://example.com/old",
        status: 301,
        statusText: "moved permanently",
        headers: { Location: "https://example.com/new" },
        mimeType: "text/html",
      },
    });
    agent.responseReceived(rid, "https://example.com/new", { mimeType: "text/html" });
    agent.loadingFinished(rid, 512, 40);

    const records = store.records(8081);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      layerId: rid,
      state: "complete",
      request: { url: "http://example.com/old" },
      response: { url: "https://example.com/new", status: 200, statusText: "OK" },
    });
  });

  it("keeps every record through a download of 1000 body chunks between two small requests", () => {
    const store = newStore();
    const agent = agentOn(store);
    const [before, download, after] = [randomUUID(), randomUUID(), randomUUID()];

    agent.complete(before, "https://api.example.com/before");
    agent.requestWillBeSent(download, "https://cdn.example.com/video.mp4");
    agent.responseReceived(download, "https://cdn.example.com/video.mp4", {
      mimeType: "video/mp4",
      type: "Media",
    });
    for (let i = 0; i < 1000; i++) agent.dataReceived(download, 65_536);
    agent.loadingFinished(download, 65_536_000, 9_000);
    agent.complete(after, "https://api.example.com/after");

    const records = store.records(8081);
    expect(records.map((r) => [r.layerId, r.state])).toEqual([
      [before, "complete"],
      [download, "complete"],
      [after, "complete"],
    ]);
    expect(records[1]!.encodedDataLength).toBe(65_536_000);
    for (const record of records) expect(store.record(record.id)).toBe(record);
  });

  it("reads the capture state from the host on every call", () => {
    let armed = false;
    const store = createIosNetworkRecords(() => ({ armed, pid: 4242 }));
    expect(store.state()).toEqual({ armed: false, pid: 4242 });
    armed = true;
    expect(store.state()).toEqual({ armed: true, pid: 4242 });
  });
});

describe("iOS native network records: eviction", () => {
  it(`evicts the oldest record once a request past ${MAX_RECORDS} arrives`, () => {
    const store = newStore();
    const agent = agentOn(store);

    for (let i = 0; i < MAX_RECORDS; i++) agent.requestWillBeSent(`r${i}`, `https://e.com/${i}`);
    const first = idOf(store, "r0");
    const second = idOf(store, "r1");
    expect(store.records(8081)).toHaveLength(MAX_RECORDS);

    agent.requestWillBeSent("newest", "https://e.com/newest");

    const records = store.records(8081);
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[0]!.layerId).toBe("r1");
    expect(records.at(-1)!.layerId).toBe("newest");
    expect(store.record(first)).toBeUndefined();
    expect(store.record(second)).toBeDefined();

    // The evicted request's late events open nothing.
    agent.loadingFinished("r0", 10, 5);
    expect(store.records(8081)).toHaveLength(MAX_RECORDS);
    expect(store.records(8081).some((r) => r.layerId === "r0")).toBe(false);
  });

  it("evicts the oldest records first once their strings pass the size budget", () => {
    const store = newStore();
    const agent = agentOn(store);
    const send = (i: number): void =>
      agent.requestWillBeSent(`big-${i}`, `https://e.com/${String(i).padStart(4, "0")}`, {
        headers: LARGE_HEADERS,
      });

    send(0);
    const size = recordSize(store.record(idOf(store, "big-0"))!);
    expect(size).toBeGreaterThan(4 * LARGE_VALUE.length);
    const fit = Math.floor(RECORD_CHARS_BUDGET / size);
    expect(fit).toBeLessThan(MAX_RECORDS);
    for (let i = 1; i < fit; i++) send(i);
    expect(store.records(8081)).toHaveLength(fit);
    const ids = store.records(8081).map((r) => r.id);

    send(fit);
    expect(store.records(8081)).toHaveLength(fit);
    expect(store.records(8081)[0]!.layerId).toBe("big-1");
    expect(store.record(ids[0]!)).toBeUndefined();
    expect(store.record(ids[1]!)).toBeDefined();

    send(fit + 1);
    expect(store.records(8081)[0]!.layerId).toBe("big-2");
    expect(store.record(ids[1]!)).toBeUndefined();
    expect(store.records(8081).at(-1)!.layerId).toBe(`big-${fit + 1}`);
  });

  it("evicts the oldest record when a response grows the store past the size budget", () => {
    const store = newStore();
    const agent = agentOn(store);
    const send = (i: number): void =>
      agent.requestWillBeSent(`big-${i}`, `https://e.com/${String(i).padStart(4, "0")}`, {
        headers: LARGE_HEADERS,
      });

    send(0);
    const fit = Math.floor(RECORD_CHARS_BUDGET / recordSize(store.record(idOf(store, "big-0"))!));
    for (let i = 1; i < fit; i++) send(i);
    const oldest = idOf(store, "big-0");

    agent.responseReceived(`big-${fit - 1}`, `https://e.com/${fit - 1}`, {
      headers: LARGE_HEADERS,
    });

    expect(store.records(8081)).toHaveLength(fit - 1);
    expect(store.records(8081)[0]!.layerId).toBe("big-1");
    expect(store.record(oldest)).toBeUndefined();
    expect(store.records(8081).at(-1)).toMatchObject({
      layerId: `big-${fit - 1}`,
      state: "headers",
    });
  });
});

describe("iOS native network records: ids", () => {
  it("gives ids of the ios-native shape that stay unique across stores", () => {
    const a = newStore();
    const b = newStore();
    const rid = randomUUID();

    agentOn(a).requestWillBeSent(rid, "https://api.example.com/a");
    agentOn(b).requestWillBeSent(rid, "https://api.example.com/b");

    const idA = idOf(a, rid);
    const idB = idOf(b, rid);
    expect(idA).toMatch(IOS_NATIVE_REQUEST_ID);
    expect(idB).toMatch(IOS_NATIVE_REQUEST_ID);
    expect(idA).not.toBe(idB);
    // One tag per tool-server start, shared by every store.
    expect(idA.split("-")[1]).toBe(idB.split("-")[1]);
    expect(a.record(idB)).toBeUndefined();
    expect(b.record(idA)).toBeUndefined();
    expect(IOS_NATIVE_REQUEST_ID.test("ios-12")).toBe(false);
    expect(IOS_NATIVE_REQUEST_ID.test("android-0a1b-1")).toBe(false);
  });
});

describe("iOS native network records: clear", () => {
  it("hides every record on clear while their ids still resolve", () => {
    const store = newStore();
    const agent = agentOn(store);
    unregisters.push(
      registerIosNetworkCaptures({
        udid: UDID,
        bundleIds: new Set(),
        stores: new Map([[BUNDLE, store]]),
      })
    );

    agent.complete("a", "https://api.example.com/a");
    agent.complete("b", "https://api.example.com/b");
    const [a, b] = store.records(8081);

    store.clear();

    expect(store.records(8081)).toEqual([]);
    expect(store.record(a!.id)).toBe(a);
    expect(store.record(b!.id)).toBe(b);
    expect(findIosNativeRecord(a!.id)).toEqual({ records: store, record: a });
    expect(findIosNativeRecord(b!.id)?.record).toBe(b);
    expect(findIosNativeRecord("ios-0000-999999999")).toBeUndefined();

    agent.complete("c", "https://api.example.com/c");
    expect(store.records(8081).map((r) => r.layerId)).toEqual(["c"]);
  });

  it("finds no record once the captures that hold it are unregistered", () => {
    const store = newStore();
    agentOn(store).complete("a", "https://api.example.com/a");
    const id = idOf(store, "a");
    const unregister = registerIosNetworkCaptures({
      udid: UDID,
      bundleIds: new Set(),
      stores: new Map([[BUNDLE, store]]),
    });
    try {
      expect(findIosNativeRecord(id)?.record.layerId).toBe("a");
    } finally {
      unregister();
    }
    expect(findIosNativeRecord(id)).toBeUndefined();
  });

  it("lists a request in flight at the clear again once it finishes or fails", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.complete("done", "https://api.example.com/done");
    agent.requestWillBeSent("pending", "https://api.example.com/pending");
    agent.requestWillBeSent("headers", "https://api.example.com/headers");
    agent.responseReceived("headers", "https://api.example.com/headers");
    agent.requestWillBeSent("slow", "https://api.example.com/slow");

    store.clear();
    expect(store.records(8081)).toEqual([]);

    // A response alone does not settle it.
    agent.responseReceived("slow", "https://api.example.com/slow");
    expect(store.records(8081)).toEqual([]);

    agent.loadingFinished("pending", 10, 5);
    expect(store.records(8081).map((r) => [r.layerId, r.state])).toEqual([["pending", "complete"]]);

    agent.loadingFailed("headers", "cancelled", 6);
    expect(store.records(8081).map((r) => [r.layerId, r.state])).toEqual([
      ["pending", "complete"],
      ["headers", "failed"],
    ]);
    expect(store.records(8081).some((r) => r.layerId === "done")).toBe(false);
  });
});

describe("iOS native network records: Metro filter", () => {
  it("leaves out Metro's own loopback traffic on the caller's port only", () => {
    const store = newStore();
    const agent = agentOn(store);
    const urls = {
      localhost: "http://localhost:8081/index.bundle?platform=ios",
      ipv4: "http://127.0.0.1:8081/symbolicate",
      ipv6: "http://[::1]:8081/hot",
      lan: "http://192.168.1.20:8081/api/users",
      other: "http://localhost:9000/api/items",
    };
    for (const [name, url] of Object.entries(urls)) agent.complete(name, url);

    expect(store.records(8081).map((r) => r.layerId)).toEqual(["lan", "other"]);
    expect(store.records(9000).map((r) => r.layerId)).toEqual(["localhost", "ipv4", "ipv6", "lan"]);
    // Filtered, not dropped.
    expect(store.records(4000)).toHaveLength(5);
  });
});

describe("iOS native network records: connection closed", () => {
  /** Two open requests, two settled ones on CONN, and one open on OTHER_CONN. */
  function withOpenRequests() {
    const store = newStore();
    const agent = agentOn(store, CONN);
    const other = agentOn(store, OTHER_CONN);

    agent.requestWillBeSent("pending", "https://api.example.com/pending");
    agent.requestWillBeSent("headers", "https://api.example.com/headers");
    agent.responseReceived("headers", "https://api.example.com/headers");
    agent.complete("complete", "https://api.example.com/complete");
    agent.requestWillBeSent("failed", "https://api.example.com/failed");
    agent.loadingFailed("failed", "The request timed out.", 60_000);
    other.requestWillBeSent("other", "https://api.example.com/other");

    const byLayerId = (layerId: string) => store.records(8081).find((r) => r.layerId === layerId)!;
    return { store, byLayerId };
  }

  it.each<[string, ClosedConnectionCheck, string]>([
    ["a newer connection superseded it", { superseded: true }, PROCESS_ENDED],
    ["the app no longer runs", { superseded: false, running: false }, PROCESS_ENDED],
    [
      "another process of the app runs",
      { superseded: false, running: true, runningPid: 200, connectionPid: 100 },
      PROCESS_ENDED,
    ],
    [
      "the same process still runs",
      { superseded: false, running: true, runningPid: 100, connectionPid: 100 },
      NOT_RECONNECTED,
    ],
    ["the host could not tell", { superseded: false }, NOT_RECONNECTED],
    [
      "the process runs and the connection's pid was never read",
      { superseded: false, running: true, runningPid: 200 },
      NOT_RECONNECTED,
    ],
  ])("fails the connection's open requests when %s", (_why, check, reason) => {
    const { store, byLayerId } = withOpenRequests();
    expect(store.hasOpenRecords(CONN)).toBe(true);
    expect(store.hasOpenRecords(OTHER_CONN)).toBe(true);

    store.connectionClosed(CONN, check);

    expect(byLayerId("pending")).toMatchObject({ state: "failed", errorText: reason });
    expect(byLayerId("headers")).toMatchObject({
      state: "failed",
      errorText: reason,
      response: { status: 200 },
    });
    expect(byLayerId("complete").state).toBe("complete");
    expect(byLayerId("complete").errorText).toBeUndefined();
    expect(byLayerId("failed")).toMatchObject({
      state: "failed",
      errorText: "The request timed out.",
    });
    expect(byLayerId("other").state).toBe("pending");
    expect(store.hasOpenRecords(CONN)).toBe(false);
    expect(store.hasOpenRecords(OTHER_CONN)).toBe(true);
  });

  it("lists a cleared open request again once its connection closes", () => {
    const { store } = withOpenRequests();

    store.clear();
    store.connectionClosed(CONN, { superseded: true });

    expect(store.records(8081).map((r) => [r.layerId, r.state, r.errorText])).toEqual([
      ["pending", "failed", PROCESS_ENDED],
      ["headers", "failed", PROCESS_ENDED],
    ]);
  });

  it("fails every open request of a closed connection even when failing them evicts the oldest", () => {
    const store = newStore();
    let n = 0;
    const start = (headers: Record<string, string>): void =>
      store.fold(CONN, "Network.requestWillBeSent", {
        requestId: `req-${String(n++).padStart(4, "0")}`,
        wallTime: WALL_TIME,
        request: { url: "https://example.com/a", method: "GET", headers },
      });
    // Open requests that fill the size budget to within a few chars, so the
    // reason the first one gets pushes the store past it.
    start(LARGE_HEADERS);
    const size = recordSize(store.records(8081)[0]!);
    const fit = Math.floor(RECORD_CHARS_BUDGET / size);
    for (let i = 1; i < fit; i++) start(LARGE_HEADERS);
    const filler = RECORD_CHARS_BUDGET - fit * size - (21 + 3 + 3 + 3 + 256) - 10;
    start({ "x-f": "y".repeat(filler - 40_000 - 3), "x-g": "z".repeat(40_000) });
    const used = store.records(8081).reduce((sum, r) => sum + recordSize(r), 0);
    expect(RECORD_CHARS_BUDGET - used).toBeLessThan(PROCESS_ENDED.length);

    store.connectionClosed(CONN, { superseded: true });

    expect(store.hasOpenRecords(CONN)).toBe(false);
    expect(store.records(8081).every((r) => r.state === "failed")).toBe(true);
  });

  it("does nothing for a connection with no open requests", () => {
    const { store, byLayerId } = withOpenRequests();

    store.connectionClosed(3, { superseded: true });

    expect(byLayerId("pending").state).toBe("pending");
    expect(byLayerId("other").state).toBe("pending");
    expect(store.hasOpenRecords(3)).toBe(false);
  });
});

describe("iOS native network records: events that name no open request", () => {
  it("ignores events for a request it never saw start", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.responseReceived("unknown", "https://api.example.com/x");
    agent.dataReceived("unknown", 10);
    agent.loadingFinished("unknown", 10, 5);
    agent.loadingFailed("unknown", "offline", 5);

    expect(store.records(8081)).toEqual([]);
    expect(store.hasOpenRecords(CONN)).toBe(false);
  });

  it("ignores a request id longer than 200 characters", () => {
    const store = newStore();
    const agent = agentOn(store);

    agent.requestWillBeSent("x".repeat(201), "https://api.example.com/long");
    expect(store.records(8081)).toEqual([]);

    agent.requestWillBeSent("y".repeat(200), "https://api.example.com/longest");
    expect(store.records(8081).map((r) => r.request.url)).toEqual([
      "https://api.example.com/longest",
    ]);
  });

  it("ignores params that are not an object or carry no string request id", () => {
    const store = newStore();
    const start = { url: "https://api.example.com/a", method: "GET", headers: {} };

    for (const params of [null, undefined, "requestId", 42, true, []]) {
      store.fold(CONN, "Network.requestWillBeSent", params);
    }
    store.fold(CONN, "Network.requestWillBeSent", { requestId: 7, request: start });
    store.fold(CONN, "Network.requestWillBeSent", { requestId: "", request: start });

    expect(store.records(8081)).toEqual([]);
  });

  it("leaves a request untouched by events with its id on another connection", () => {
    const store = newStore();
    const agent = agentOn(store, CONN);
    const other = agentOn(store, OTHER_CONN);
    const rid = randomUUID();

    agent.requestWillBeSent(rid, "https://api.example.com/a");
    const before = structuredClone(store.records(8081));

    other.responseReceived(rid, "https://api.example.com/a", { status: 500 });
    other.dataReceived(rid, 100);
    other.loadingFinished(rid, 100, 5);
    other.loadingFailed(rid, "offline", 5);

    expect(store.records(8081)).toEqual(before);
    expect(store.records(8081)[0]!.state).toBe("pending");
    expect(store.hasOpenRecords(CONN)).toBe(true);
    expect(store.hasOpenRecords(OTHER_CONN)).toBe(false);
  });
});

describe("iOS native network capture lookups", () => {
  const EXT = `ext:acme-1:${UDID}`;
  const LOGICAL = "metro-logical-1";
  /** Sorts before UDID. */
  const OTHER_UDID = "0F1E2D3C-0000-4000-8000-00000000BBBB";

  function captureOn(udid: string, bundleIds: string[]): () => void {
    const unregister = registerIosNetworkCaptures({
      udid,
      bundleIds: new Set(bundleIds),
      stores: new Map(),
    });
    unregisters.push(unregister);
    return unregister;
  }

  it("finds a device's captures by its udid, an ext: id with that udid behind it, or a Metro logicalDeviceId aliased to it", () => {
    captureOn(UDID, [BUNDLE]);
    rememberDeviceAlias(LOGICAL, UDID);

    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptures(EXT)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptures(LOGICAL)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptures(OTHER_UDID)).toEqual([]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([UDID]);
  });

  it("finds a service registered under an ext: id by the udid behind it, and names the device by that ext: id", () => {
    captureOn(EXT, [BUNDLE]);
    rememberDeviceAlias(LOGICAL, EXT);

    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptures(EXT)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptures(LOGICAL)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([EXT]);
    expect(liveIosNetworkCaptureDevices("com.example.other")).toEqual([]);
  });

  it("sorts and de-duplicates across services, and drops a service from both lookups once it is unregistered", () => {
    const first = captureOn(UDID, ["com.example.zeta", BUNDLE]);
    const second = captureOn(UDID, [BUNDLE, "com.example.alpha"]);
    captureOn(OTHER_UDID, [BUNDLE]);

    expect(liveIosNetworkCaptures(UDID)).toEqual(["com.example.alpha", BUNDLE, "com.example.zeta"]);
    expect(liveIosNetworkCaptures(OTHER_UDID)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([OTHER_UDID, UDID]);
    expect(liveIosNetworkCaptureDevices("com.example.alpha")).toEqual([UDID]);

    second();
    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE, "com.example.zeta"]);
    expect(liveIosNetworkCaptureDevices("com.example.alpha")).toEqual([]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([OTHER_UDID, UDID]);

    first();
    expect(liveIosNetworkCaptures(UDID)).toEqual([]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([OTHER_UDID]);
  });
});
