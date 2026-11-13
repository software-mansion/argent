import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import {
  IOS_NATIVE_REQUEST_ID,
  KEPT_BODY_CHARS_BUDGET,
  createIosNetworkRecords,
  findIosNativeRecord,
  liveIosNetworkCaptureDevices,
  liveIosNetworkCaptures,
  registerIosNetworkCaptures,
  type ClosedConnectionCheck,
  type IosAgentLink,
  type IosNetworkRecordStore,
} from "../src/blueprints/ios-network-records";
import { rememberDeviceAlias, resetDeviceAliases } from "../src/utils/debugger/device-alias";
import {
  MAX_CACHED_BODIES,
  MAX_RECORDS,
  MAX_VALUE_CHARS,
  NOT_RECONNECTED,
  PROCESS_ENDED,
  PROCESS_GONE,
  RECORD_CHARS_BUDGET,
  recordSize,
  type NativeNetworkBody,
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
  vi.useRealTimers();
});

const LABEL = `native-devtools ${BUNDLE}`;

/** The requester's rejections, built as `createNdjsonCdpRequester` builds them. */
function agentError(method: string, message: string): FailureError {
  return new FailureError(`${LABEL}: ${method} failed: ${message}`, {
    error_code: FAILURE_CODES.NDJSON_CDP_REQUEST_FAILED,
    failure_stage: "ndjson_cdp_response",
    failure_area: "tool_server",
    error_kind: "subprocess",
  });
}

function timeoutError(method: string, timeoutMs: number): FailureError {
  return new FailureError(`${LABEL}: ${method} got no reply within ${timeoutMs} ms`, {
    error_code: FAILURE_CODES.NDJSON_CDP_REQUEST_TIMEOUT,
    failure_stage: "ndjson_cdp_request",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}

function closedError(method: string): FailureError {
  return new FailureError(`${LABEL}: the connection closed before ${method} was answered`, {
    error_code: FAILURE_CODES.NDJSON_CDP_CONNECTION_CLOSED,
    failure_stage: "ndjson_cdp_request",
    failure_area: "tool_server",
    error_kind: "network",
  });
}

/** One request the store sent to the app, answered when a test says so. */
interface SentRead {
  connection: number;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  reply(result: unknown): void;
  fail(error: unknown): void;
}

/**
 * The app's side of the body reads: a request on the live connection stays
 * open until the test answers it, and times out like the real requester.
 */
function fakeApp(initialLive: number | undefined = CONN) {
  let live: number | undefined = initialLive;
  const sent: SentRead[] = [];
  const request = vi.fn<IosAgentLink["request"]>((connection, method, params, timeoutMs) => {
    if (connection !== live) return Promise.reject(closedError(method));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError(method, timeoutMs)), timeoutMs);
      timer.unref();
      sent.push({
        connection,
        method,
        params,
        timeoutMs,
        reply: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        fail: (error) => {
          clearTimeout(timer);
          // A test also rejects with a value that is not an Error, which a read must survive.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        },
      });
    });
  });
  const link: IosAgentLink = { liveConnection: () => live, request };
  return {
    link,
    request,
    sent,
    setLive(connection: number | undefined): void {
      live = connection;
    },
  };
}

function newStore(link: IosAgentLink = fakeApp().link): IosNetworkRecordStore {
  return createIosNetworkRecords(() => ({ armed: true }), link);
}

/** A store whose body reads go to a fake app, with the agent on CONN. */
function bodyStore(live: number | undefined = CONN) {
  const app = fakeApp(live);
  const store = newStore(app.link);
  return { app, store, agent: agentOn(store, CONN) };
}

/** Lets every queued promise callback run: a body read goes out a few of them after the call. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Whether a promise has settled yet, and with what. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function body(text: string, extra: Partial<NativeNetworkBody> = {}): NativeNetworkBody {
  return { available: true, body: text, base64Encoded: false, truncated: false, ...extra };
}

function refused(reason: string): NativeNetworkBody {
  return { available: false, body: "", base64Encoded: false, truncated: false, reason };
}

const STILL_SENDING = "the app is still sending this request body; read it again later";
const NO_ANSWER = "the app did not answer within 5 s; read it again later";
const CONNECTION_CLOSED = "the agent's connection closed before this body was read";

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
    const store = createIosNetworkRecords(() => ({ armed, pid: 4242 }), fakeApp().link);
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

  it("releases an evicted record to the garbage collector", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const store = newStore();
    const agent = agentOn(store);

    agent.requestWillBeSent("r0", "https://e.com/0");
    const evicted = new WeakRef(store.record(idOf(store, "r0"))!);
    for (let i = 1; i <= MAX_RECORDS; i++) agent.requestWillBeSent(`r${i}`, `https://e.com/${i}`);
    expect(store.records(8081)[0]!.layerId).toBe("r1");

    // A WeakRef keeps its target alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    expect(evicted.deref()).toBeUndefined();
    // The store outlives the collection, so only the eviction can have freed the record.
    expect(store.records(8081)).toHaveLength(MAX_RECORDS);
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
    const openOn = (connection: number): string[] =>
      store
        .records(8081)
        .filter(
          (r) => r.connection === connection && (r.state === "pending" || r.state === "headers")
        )
        .map((r) => r.layerId);
    return { store, byLayerId, openOn };
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
    const { store, byLayerId, openOn } = withOpenRequests();
    expect(openOn(CONN)).toEqual(["pending", "headers"]);
    expect(openOn(OTHER_CONN)).toEqual(["other"]);

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
    expect(openOn(CONN)).toEqual([]);
    expect(openOn(OTHER_CONN)).toEqual(["other"]);
    // The records stay, settled.
    expect(store.holdsRecordsOf(CONN)).toBe(true);
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

    expect(store.records(8081).length).toBeGreaterThan(1);
    expect(store.records(8081).every((r) => r.state === "failed")).toBe(true);
  });

  it("does nothing for a connection with no open requests", () => {
    const { store, byLayerId } = withOpenRequests();

    store.connectionClosed(3, { superseded: true });

    expect(byLayerId("pending").state).toBe("pending");
    expect(byLayerId("other").state).toBe("pending");
    expect(store.holdsRecordsOf(3)).toBe(false);
  });

  it("still holds a closed connection's records, and none once they are evicted", () => {
    const store = newStore();
    agentOn(store, CONN).complete("a", "https://api.example.com/a");
    store.connectionClosed(CONN, { superseded: true });
    expect(store.holdsRecordsOf(CONN)).toBe(true);

    const other = agentOn(store, OTHER_CONN);
    for (let i = 0; i < MAX_RECORDS; i++) other.requestWillBeSent(`r${i}`, `https://e.com/${i}`);

    expect(store.holdsRecordsOf(CONN)).toBe(false);
    expect(store.holdsRecordsOf(OTHER_CONN)).toBe(true);
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
    expect(store.holdsRecordsOf(CONN)).toBe(false);
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
    expect(store.holdsRecordsOf(CONN)).toBe(true);
    expect(store.holdsRecordsOf(OTHER_CONN)).toBe(false);
  });
});

describe("iOS native network capture lookups", () => {
  const EXT = `ext:acme-1:${UDID}`;
  const LOGICAL = "metro-logical-1";
  /** Sorts before UDID. */
  const OTHER_UDID = "0F1E2D3C-0000-4000-8000-00000000BBBB";

  /** Capture is on for each app, and each app connected, so it has records. */
  function captureOn(udid: string, bundleIds: string[], connected = bundleIds): () => void {
    const unregister = registerIosNetworkCaptures({
      udid,
      bundleIds: new Set(bundleIds),
      stores: new Map(connected.map((bundleId) => [bundleId, newStore()])),
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

  /** A mistyped bundle id is turned on too, and must not be named by every later profile. */
  it("leaves out an app that capture is on for but that never connected", () => {
    captureOn(UDID, [BUNDLE, "com.example.typo"], [BUNDLE]);

    expect(liveIosNetworkCaptures(UDID)).toEqual([BUNDLE]);
    expect(liveIosNetworkCaptureDevices("com.example.typo")).toEqual([]);
    expect(liveIosNetworkCaptureDevices(BUNDLE)).toEqual([UDID]);
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

describe("iOS native network records: body refusals", () => {
  it("refuses both bodies of an id it does not know, and asks the app nothing", async () => {
    const { app, store } = bodyStore();

    expect(await store.responseBody("ios-0000-999999999")).toEqual(refused("no such request"));
    expect(await store.requestPostData("ios-0000-999999999")).toEqual(refused("no such request"));
    expect(app.request).not.toHaveBeenCalled();
  });

  it("refuses the request body of a request sent without one, and asks the app nothing", async () => {
    const { app, store, agent } = bodyStore();
    agent.complete("get", "https://api.example.com/get");

    expect(await store.requestPostData(idOf(store, "get"))).toEqual(
      refused("the request has no body")
    );
    expect(app.request).not.toHaveBeenCalled();
  });

  it.each<[string, (agent: ReturnType<typeof agentOn>, rid: string) => void, string]>([
    [
      "still waits for its response",
      (agent, rid) => agent.requestWillBeSent(rid, "https://api.example.com/a"),
      "the response has not finished yet",
    ],
    [
      "has its headers but not its end",
      (agent, rid) => {
        agent.requestWillBeSent(rid, "https://api.example.com/a");
        agent.responseReceived(rid, "https://api.example.com/a");
      },
      "the response has not finished yet",
    ],
    [
      "failed after its headers arrived",
      (agent, rid) => {
        agent.requestWillBeSent(rid, "https://api.example.com/a");
        agent.responseReceived(rid, "https://api.example.com/a");
        agent.loadingFailed(rid, "cancelled", 5);
      },
      "the response failed before its body finished",
    ],
    [
      "failed before a response arrived",
      (agent, rid) => {
        agent.requestWillBeSent(rid, "https://api.example.com/a");
        agent.loadingFailed(rid, "The Internet connection appears to be offline.", 5);
      },
      "the request failed before a response arrived",
    ],
    [
      "finished with 0 bytes",
      (agent, rid) => {
        agent.requestWillBeSent(rid, "https://api.example.com/a");
        agent.responseReceived(rid, "https://api.example.com/a", { status: 204 });
        agent.loadingFinished(rid, 0, 5);
      },
      "the response has no body",
    ],
  ])(
    "refuses the response body of a request that %s, and asks the app nothing",
    async (_why, make, reason) => {
      const { app, store, agent } = bodyStore();
      make(agent, "r");

      expect(await store.responseBody(idOf(store, "r"))).toEqual(refused(reason));
      expect(app.request).not.toHaveBeenCalled();
    }
  );
});

describe("iOS native network records: body reads", () => {
  it("reads a response body by the app's request id on the request's connection, once per record", async () => {
    const { app, store, agent } = bodyStore(OTHER_CONN);
    const rid = randomUUID();
    agentOn(store, OTHER_CONN).complete(rid, "https://api.example.com/a");
    agent.complete("elsewhere", "https://api.example.com/b");
    const id = idOf(store, rid);

    // 2 reads at once share 1 request.
    const first = store.responseBody(id);
    const second = store.responseBody(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    expect(app.request).toHaveBeenCalledWith(
      OTHER_CONN,
      "Network.getResponseBody",
      { requestId: rid },
      10_000
    );

    app.sent[0]!.reply({ body: "eyJvayI6dHJ1ZX0=", base64Encoded: true, wasTruncated: true });
    const expected = body("eyJvayI6dHJ1ZX0=", { base64Encoded: true, truncated: true });
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(await store.responseBody(id)).toEqual(expected);
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("reads a request body by the app's request id with no timeout of its own, once per record", async () => {
    const { app, store, agent } = bodyStore();
    const rid = randomUUID();
    agent.requestWillBeSent(rid, "https://api.example.com/upload", {
      method: "PUT",
      hasPostData: true,
    });
    const id = idOf(store, rid);

    const read = store.requestPostData(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    expect(app.request).toHaveBeenCalledWith(
      CONN,
      "Network.getRequestPostData",
      { requestId: rid },
      2 ** 31 - 1
    );

    app.sent[0]!.reply({ postData: '{"name":"demo"}', base64Encoded: false });
    expect(await read).toEqual(body('{"name":"demo"}'));
    expect(await store.requestPostData(id)).toEqual(body('{"name":"demo"}'));
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it.each<[string, "response" | "post", (read: SentRead) => void, string]>([
    [
      "the agent no longer holding a response body",
      "response",
      (read) => read.fail(agentError(read.method, "No response body stored for requestId")),
      "the agent no longer holds this body",
    ],
    [
      "the agent holding no request body",
      "post",
      (read) => read.fail(agentError(read.method, "No request stored for requestId")),
      "the agent holds no body for this request",
    ],
    [
      "another agent error on a response body",
      "response",
      (read) => read.fail(agentError(read.method, "Native network inspector exception")),
      "the agent did not return the body: Native network inspector exception",
    ],
    [
      "another agent error on a request body",
      "post",
      (read) => read.fail(agentError(read.method, "Native network inspector exception")),
      "the agent did not return the body: Native network inspector exception",
    ],
    [
      "a response body with no reply in time",
      "response",
      (read) => read.fail(timeoutError(read.method, read.timeoutMs)),
      `the agent did not return the body: ${LABEL}: Network.getResponseBody got no reply within 10000 ms`,
    ],
    [
      "a plain error",
      "response",
      (read) => read.fail(new Error("socket hang up")),
      "the agent did not return the body: socket hang up",
    ],
    [
      "a rejection that is not an error",
      "post",
      (read) => read.fail("boom"),
      "the agent did not return the body: boom",
    ],
    [
      "a response reply with no body",
      "response",
      (read) => read.reply({ bodyAvailable: false }),
      "the agent holds no body for this response",
    ],
  ])(
    "answers %s with a reason it does not keep, so the next read asks again",
    async (_why, kind, answer, reason) => {
      const { app, store, agent } = bodyStore();
      agent.requestWillBeSent("r", "https://api.example.com/a", {
        method: "POST",
        hasPostData: true,
      });
      agent.responseReceived("r", "https://api.example.com/a");
      agent.loadingFinished("r", 10, 5);
      const id = idOf(store, "r");
      const read = (): Promise<NativeNetworkBody> =>
        kind === "response" ? store.responseBody(id) : store.requestPostData(id);

      const first = read();
      await settle();
      expect(app.request).toHaveBeenCalledTimes(1);
      answer(app.sent[0]!);
      expect(await first).toEqual(refused(reason));

      const second = read();
      await settle();
      expect(app.request).toHaveBeenCalledTimes(2);
      app.sent[1]!.reply(
        kind === "response"
          ? { body: "ok", base64Encoded: false, wasTruncated: false }
          : { postData: "ok", base64Encoded: false }
      );
      expect(await second).toEqual(body("ok"));
    }
  );

  it.each<[string, "response" | "post"]>([
    ["response", "response"],
    ["request", "post"],
  ])(
    "answers a %s body read whose request throws at once, and the next read asks again",
    async (_body, kind) => {
      const { app, store, agent } = bodyStore();
      agent.requestWillBeSent("r", "https://api.example.com/a", {
        method: "POST",
        hasPostData: true,
      });
      agent.responseReceived("r", "https://api.example.com/a");
      agent.loadingFinished("r", 10, 5);
      const id = idOf(store, "r");
      const read = (): Promise<NativeNetworkBody> =>
        kind === "response" ? store.responseBody(id) : store.requestPostData(id);
      app.request.mockImplementationOnce(() => {
        throw new Error("socket is not writable");
      });

      const first = track(read());
      await settle();
      expect(first.value).toEqual(
        refused("the agent did not return the body: socket is not writable")
      );

      const second = read();
      await settle();
      expect(app.request).toHaveBeenCalledTimes(2);
      app.sent[0]!.reply(
        kind === "response"
          ? { body: "ok", base64Encoded: false, wasTruncated: false }
          : { postData: "ok", base64Encoded: false }
      );
      expect(await second).toEqual(body("ok"));
    }
  );
});

describe("iOS native network records: request body still being sent", () => {
  function uploading() {
    vi.useFakeTimers();
    const { app, store, agent } = bodyStore();
    agent.requestWillBeSent("upload", "https://api.example.com/upload", {
      method: "POST",
      hasPostData: true,
    });
    return { app, store, agent, id: idOf(store, "upload") };
  }

  it("a request body read answers within 5 s while the app is still sending it, and later reads wait on the same request", async () => {
    const { app, store, id } = uploading();

    const first = track(store.requestPostData(id));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.value).toEqual(refused(STILL_SENDING));

    // A second read asks the app nothing and waits its own 5 s.
    const second = track(store.requestPostData(id));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(second.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.value).toEqual(refused(STILL_SENDING));
    expect(app.request).toHaveBeenCalledTimes(1);

    // A read waiting when the app ends the body gets it then.
    const third = track(store.requestPostData(id));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(third.settled).toBe(false);
    app.sent[0]!.reply({ postData: "x".repeat(300), base64Encoded: false });
    await settle();
    expect(third.value).toEqual(body("x".repeat(300)));

    expect(await store.requestPostData(id)).toEqual(body("x".repeat(300)));
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("says the app did not answer, not that it is still sending, once the request has a response", async () => {
    const { app, store, agent, id } = uploading();
    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);

    const read = track(store.requestPostData(id));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.value).toEqual(refused(NO_ANSWER));

    // The read stayed open, so the app's late answer still comes.
    const again = store.requestPostData(id);
    app.sent[0]!.reply({ postData: "done", base64Encoded: false });
    expect(await again).toEqual(body("done"));
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("asks the app again once a read it held open during the upload is unanswered 5 s after the upload ended", async () => {
    const { app, store, agent, id } = uploading();
    const during = track(store.requestPostData(id));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(during.value).toEqual(refused(STILL_SENDING));

    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);
    // Within 5 s of the end, a read still waits on the open one.
    await vi.advanceTimersByTimeAsync(4_000);
    const soon = track(store.requestPostData(id));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(soon.value).toEqual(refused(NO_ANSWER));

    // Later, the app no longer holds the open read, so the next read asks again.
    const again = store.requestPostData(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
    app.sent[1]!.reply({ postData: "done", base64Encoded: false });
    expect(await again).toEqual(body("done"));
    expect(await store.requestPostData(id)).toEqual(body("done"));
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("keeps the body a read asked again for as read last, past newer bodies read while the first read was open", async () => {
    const { app, store, agent, id } = uploading();
    const during = track(store.requestPostData(id));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(during.value).toEqual(refused(STILL_SENDING));
    const lastSent = (): SentRead => app.sent[app.sent.length - 1]!;
    for (let i = 0; i < MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      const read = store.responseBody(idOf(store, `r${i}`));
      await settle();
      lastSent().reply({ body: `body ${i}`, base64Encoded: false, wasTruncated: false });
      await read;
    }
    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);
    await vi.advanceTimersByTimeAsync(5_000);

    const again = store.requestPostData(id);
    await settle();
    lastSent().reply({ postData: "done", base64Encoded: false });
    expect(await again).toEqual(body("done"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 2);
    const later = track(store.requestPostData(id));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 2);
    expect(later.value).toEqual(body("done"));
  });

  it("asks nothing again for a read the app held open and answered", async () => {
    const { app, store, agent, id } = uploading();
    const during = store.requestPostData(id);
    await settle();
    app.sent[0]!.reply({ postData: "done", base64Encoded: false });
    expect(await during).toEqual(body("done"));
    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await store.requestPostData(id)).toEqual(body("done"));
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("never asks again for a read that waited its turn and went out after the upload ended", async () => {
    const { app, store, agent, id } = uploading();
    agent.complete("other", "https://e.com/other");
    const other = store.responseBody(idOf(store, "other"));
    await settle();
    const queued = track(store.requestPostData(id));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);

    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);
    app.sent[0]!.reply({ body: "other", base64Encoded: false, wasTruncated: false });
    await other;
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queued.value).toEqual(refused(NO_ANSWER));

    await vi.advanceTimersByTimeAsync(10_000);
    void store.requestPostData(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("counts the 5 s from the response of the upload, not from its later end", async () => {
    const { app, store, agent, id } = uploading();
    void store.requestPostData(id);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    agent.responseReceived("upload", "https://api.example.com/upload");
    await vi.advanceTimersByTimeAsync(4_000);
    agent.loadingFinished("upload", 2);
    await vi.advanceTimersByTimeAsync(1_000);

    void store.requestPostData(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("never asks again for a read sent after the upload ended, however late the app answers", async () => {
    const { app, store, agent, id } = uploading();
    agent.responseReceived("upload", "https://api.example.com/upload");
    agent.loadingFinished("upload", 2);

    for (let i = 0; i < 4; i++) {
      const read = track(store.requestPostData(id));
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(read.value).toEqual(refused(NO_ANSWER));
    }
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it("gives the reason by the request's state when the wait ends, not when the read went out", async () => {
    const { store, agent, id } = uploading();

    const read = track(store.requestPostData(id));
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    agent.responseReceived("upload", "https://api.example.com/upload");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read.value).toEqual(refused(NO_ANSWER));
  });

  it("keeps a request body read open until the app answers, so a long upload is asked for once", async () => {
    const { app, store, id } = uploading();

    // Read every 6 s through a 150 s upload.
    for (let at = 0; at < 150_000; at += 6_000) {
      const read = track(store.requestPostData(id));
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.value).toEqual(refused(STILL_SENDING));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(app.request).toHaveBeenCalledTimes(1);

    const last = store.requestPostData(id);
    app.sent[0]!.reply({ postData: "done", base64Encoded: false });
    expect(await last).toEqual(body("done"));
    expect(await store.requestPostData(id)).toEqual(body("done"));
    expect(app.request).toHaveBeenCalledTimes(1);
  });

  it(`keeps a request body read open while ${MAX_CACHED_BODIES} newer bodies are read`, async () => {
    const { app, store, agent, id } = uploading();
    const first = track(store.requestPostData(id));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.value).toEqual(refused(STILL_SENDING));

    const lastSent = (): SentRead => app.sent[app.sent.length - 1]!;
    for (let i = 0; i < MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      const read = store.responseBody(idOf(store, `r${i}`));
      await settle();
      lastSent().reply({ body: `body ${i}`, base64Encoded: false, wasTruncated: false });
      expect(await read).toEqual(body(`body ${i}`));
    }
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);

    // The open read stayed: a read sends nothing, and the app's answer ends it.
    const again = store.requestPostData(id);
    await settle();
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
    app.sent[0]!.reply({ postData: "done", base64Encoded: false });
    expect(await again).toEqual(body("done"));

    // The bound held: the body read longest ago, r0, made room instead.
    const r0 = store.responseBody(idOf(store, "r0"));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 2);
    lastSent().reply({ body: "body 0", base64Encoded: false, wasTruncated: false });
    expect(await r0).toEqual(body("body 0"));
  });
});

describe("iOS native network records: one body read at a time", () => {
  it("one body read at a time per app connection", async () => {
    const { app, store, agent } = bodyStore();
    agent.complete("a", "https://api.example.com/a");
    agent.complete("b", "https://api.example.com/b");

    const a = store.responseBody(idOf(store, "a"));
    const b = track(store.responseBody(idOf(store, "b")));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    expect(app.sent[0]!.params).toEqual({ requestId: "a" });

    app.sent[0]!.reply({ body: "A", base64Encoded: false, wasTruncated: false });
    expect(await a).toEqual(body("A"));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.sent[1]!.params).toEqual({ requestId: "b" });
    expect(b.settled).toBe(false);

    app.sent[1]!.reply({ body: "B", base64Encoded: false, wasTruncated: false });
    await settle();
    expect(b.value).toEqual(body("B"));
  });

  it("sends the next body read once a request body read's 5 s wait ends with no reply", async () => {
    vi.useFakeTimers();
    const { app, store, agent } = bodyStore();
    agent.requestWillBeSent("upload", "https://api.example.com/upload", {
      method: "POST",
      hasPostData: true,
    });
    agent.complete("b", "https://api.example.com/b");
    const upload = idOf(store, "upload");

    const first = track(store.requestPostData(upload));
    const second = track(store.responseBody(idOf(store, "b")));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(app.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(first.value).toEqual(refused(STILL_SENDING));
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.sent[1]).toMatchObject({
      method: "Network.getResponseBody",
      params: { requestId: "b" },
    });

    // The request body read stayed open, so its reply can still come.
    app.sent[1]!.reply({ body: "B", base64Encoded: false, wasTruncated: false });
    app.sent[0]!.reply({ postData: "U", base64Encoded: false });
    await settle();
    expect(second.value).toEqual(body("B"));
    expect(await store.requestPostData(upload)).toEqual(body("U"));
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("starts every caller's 5 s wait for a request body once its read went out, not while it waits its turn", async () => {
    vi.useFakeTimers();
    const { app, store, agent } = bodyStore();
    agent.complete("slow", "https://api.example.com/slow");
    agent.requestWillBeSent("upload", "https://api.example.com/upload", {
      method: "POST",
      hasPostData: true,
    });
    const upload = idOf(store, "upload");

    const ahead = track(store.responseBody(idOf(store, "slow")));
    const first = track(store.requestPostData(upload));
    const second = track(store.requestPostData(upload));
    await vi.advanceTimersByTimeAsync(7_000);
    // The response read still holds the connection, so the app was never asked.
    expect(app.sent.map((r) => r.method)).toEqual(["Network.getResponseBody"]);
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    app.sent[0]!.reply({ body: "S", base64Encoded: false, wasTruncated: false });
    await settle();
    expect(ahead.value).toEqual(body("S"));
    expect(app.sent.map((r) => r.method)).toEqual([
      "Network.getResponseBody",
      "Network.getRequestPostData",
    ]);
    app.sent[1]!.reply({ postData: "U", base64Encoded: false });
    await settle();
    expect(first.value).toEqual(body("U"));
    expect(second.value).toEqual(body("U"));
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it("sends a body read on the app's new connection while one on its old connection is still open", async () => {
    const { app, store } = bodyStore(CONN);
    agentOn(store, CONN).complete("old", "https://api.example.com/old");
    agentOn(store, OTHER_CONN).complete("new", "https://api.example.com/new");

    const old = track(store.responseBody(idOf(store, "old")));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);

    app.setLive(OTHER_CONN);
    const fresh = store.responseBody(idOf(store, "new"));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.request).toHaveBeenLastCalledWith(
      OTHER_CONN,
      "Network.getResponseBody",
      { requestId: "new" },
      10_000
    );
    app.sent[1]!.reply({ body: "new", base64Encoded: false, wasTruncated: false });
    expect(await fresh).toEqual(body("new"));
    expect(old.settled).toBe(false);

    // The old connection closes under its read, with a newer one live.
    app.sent[0]!.fail(closedError("Network.getResponseBody"));
    await settle();
    expect(old.value).toEqual(refused(PROCESS_GONE));
  });

  it("never sends a read that waited its turn on a connection that closed to the app's newer connection", async () => {
    const { app, store, agent } = bodyStore(CONN);
    agent.complete("a", "https://api.example.com/a");
    agent.complete("b", "https://api.example.com/b");

    const a = store.responseBody(idOf(store, "a"));
    const b = store.responseBody(idOf(store, "b"));
    await settle();
    expect(app.request).toHaveBeenCalledTimes(1);

    // The app reconnects, and the old connection's open read fails.
    app.setLive(OTHER_CONN);
    app.sent[0]!.fail(closedError("Network.getResponseBody"));
    await settle();
    expect(app.request.mock.calls.map(([connection]) => connection)).toEqual([CONN, CONN]);
    expect(await a).toEqual(refused(PROCESS_GONE));
    expect(await b).toEqual(refused(PROCESS_GONE));
    expect(app.sent).toHaveLength(1);
  });
});

describe("iOS native network records: bodies kept", () => {
  /** Answers every read at once with a body naming the app's request id. */
  function answering() {
    const { app, store, agent } = bodyStore();
    app.request.mockImplementation(async (_connection, _method, params) => ({
      body: `body of ${String(params.requestId)}`,
      base64Encoded: false,
      wasTruncated: false,
    }));
    return { app, store, agent };
  }

  it(`keeps the ${MAX_CACHED_BODIES} bodies read most recently`, async () => {
    const { app, store, agent } = answering();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      ids.push(idOf(store, `r${i}`));
    }
    for (const id of ids) await store.responseBody(id);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);

    expect(await store.responseBody(ids[1]!)).toEqual(body("body of r1"));
    expect(await store.responseBody(ids[MAX_CACHED_BODIES]!)).toEqual(
      body(`body of r${MAX_CACHED_BODIES}`)
    );
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);

    // The 65th body pushed out the first.
    expect(await store.responseBody(ids[0]!)).toEqual(body("body of r0"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 2);
    expect(app.request).toHaveBeenLastCalledWith(
      CONN,
      "Network.getResponseBody",
      { requestId: "r0" },
      10_000
    );
  });

  it(`keeps the ${MAX_CACHED_BODIES} bodies read most recently past a read that ends with a reason or stays open`, async () => {
    vi.useFakeTimers();
    const { app, store, agent } = bodyStore();
    app.request.mockImplementation(async (_connection, method, params) => {
      if (params.requestId === "fails") throw agentError(method, "internal error");
      if (params.requestId === "upload") return new Promise(() => {});
      return { body: `body of ${String(params.requestId)}`, base64Encoded: false };
    });
    const ids: string[] = [];
    for (let i = 0; i <= MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      ids.push(idOf(store, `r${i}`));
    }
    agent.complete("fails", "https://e.com/fails");
    agent.requestWillBeSent("upload", "https://e.com/upload", {
      method: "POST",
      hasPostData: true,
    });
    for (let i = 0; i < MAX_CACHED_BODIES; i++) await store.responseBody(ids[i]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES);

    // A read that ends with a reason keeps nothing, so it pushes out nothing.
    expect(await store.responseBody(idOf(store, "fails"))).toEqual(
      refused("the agent did not return the body: internal error")
    );
    expect(await store.responseBody(ids[0]!)).toEqual(body("body of r0"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);

    // A read still open holds no body, so the next body pushes out only the oldest one.
    const upload = track(store.requestPostData(idOf(store, "upload")));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upload.value).toEqual(refused(STILL_SENDING));
    await store.responseBody(ids[MAX_CACHED_BODIES]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 3);
    expect(await store.responseBody(ids[2]!)).toEqual(body("body of r2"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 3);
  });

  it(`keeps the bodies read most recently only up to ${KEPT_BODY_CHARS_BUDGET} chars in all`, async () => {
    const { app, store, agent } = bodyStore();
    const quarter = "q".repeat(KEPT_BODY_CHARS_BUDGET / 4);
    const whole = "w".repeat(KEPT_BODY_CHARS_BUDGET + 1);
    app.request.mockImplementation(async (_connection, _method, params) => ({
      postData: params.requestId === "huge" ? whole : quarter,
      base64Encoded: false,
    }));
    const ids: string[] = [];
    for (const name of ["u0", "u1", "u2", "u3", "u4", "huge", "small"]) {
      agent.requestWillBeSent(name, `https://e.com/${name}`, { method: "POST", hasPostData: true });
      agent.responseReceived(name, `https://e.com/${name}`);
      agent.loadingFinished(name, 2);
      ids.push(idOf(store, name));
    }
    const [u0, u1, u2, u3, u4, huge, small] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    // Four quarters fill the budget; a fifth pushes out the one read longest ago.
    for (const id of [u0, u1, u2, u3, u4]) await store.requestPostData(id);
    expect(app.request).toHaveBeenCalledTimes(5);
    for (const id of [u1, u2, u3, u4]) await store.requestPostData(id);
    expect(app.request).toHaveBeenCalledTimes(5);
    await store.requestPostData(u0);
    expect(app.request).toHaveBeenCalledTimes(6);

    // A body past the budget alone stays until the next body comes.
    expect((await store.requestPostData(huge)).body).toBe(whole);
    expect(app.request).toHaveBeenCalledTimes(7);
    expect((await store.requestPostData(huge)).body).toBe(whole);
    expect(app.request).toHaveBeenCalledTimes(7);
    await store.requestPostData(small);
    await store.requestPostData(small);
    expect(app.request).toHaveBeenCalledTimes(8);
    await store.requestPostData(huge);
    expect(app.request).toHaveBeenCalledTimes(9);
  });

  it("counts a read of a kept body as a read, so the body read longest ago goes first", async () => {
    const { app, store, agent } = answering();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      ids.push(idOf(store, `r${i}`));
    }
    for (let i = 0; i < MAX_CACHED_BODIES; i++) await store.responseBody(ids[i]!);
    // r0 is read again, so r1 is now the body read longest ago.
    await store.responseBody(ids[0]!);
    await store.responseBody(ids[MAX_CACHED_BODIES]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);

    expect(await store.responseBody(ids[0]!)).toEqual(body("body of r0"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
    expect(await store.responseBody(ids[1]!)).toEqual(body("body of r1"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 2);
    expect(app.request).toHaveBeenLastCalledWith(
      CONN,
      "Network.getResponseBody",
      { requestId: "r1" },
      10_000
    );
  });

  it("drops the body of an evicted record, which no longer takes one of the places kept", async () => {
    const { app, store, agent } = answering();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_CACHED_BODIES; i++) {
      agent.complete(`r${i}`, `https://e.com/${i}`);
      ids.push(idOf(store, `r${i}`));
    }
    // Every place taken, the oldest record's body read last.
    for (let i = 1; i < MAX_CACHED_BODIES; i++) await store.responseBody(ids[i]!);
    await store.responseBody(ids[0]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES);

    // The oldest record goes, and its body with it.
    for (let i = MAX_CACHED_BODIES + 1; i <= MAX_RECORDS; i++) {
      agent.requestWillBeSent(`r${i}`, `https://e.com/${i}`);
    }
    expect(store.record(ids[0]!)).toBeUndefined();
    expect(store.record(ids[1]!)).toBeDefined();
    expect(await store.responseBody(ids[0]!)).toEqual(refused("no such request"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES);

    // So 1 more body fits without pushing out the oldest one kept.
    await store.responseBody(ids[MAX_CACHED_BODIES]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
    expect(await store.responseBody(ids[1]!)).toEqual(body("body of r1"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
  });

  it("drops the request body of an evicted record, which no longer takes one of the places kept", async () => {
    const { app, store, agent } = bodyStore();
    app.request.mockImplementation(async (_connection, _method, params) => ({
      postData: `post of ${String(params.requestId)}`,
      base64Encoded: false,
    }));
    const ids: string[] = [];
    for (let i = 0; i <= MAX_CACHED_BODIES; i++) {
      agent.requestWillBeSent(`u${i}`, `https://e.com/${i}`, { method: "POST", hasPostData: true });
      agent.responseReceived(`u${i}`, `https://e.com/${i}`);
      agent.loadingFinished(`u${i}`, 2);
      ids.push(idOf(store, `u${i}`));
    }
    // Every place taken, the oldest record's body read last.
    for (let i = 1; i < MAX_CACHED_BODIES; i++) await store.requestPostData(ids[i]!);
    await store.requestPostData(ids[0]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES);

    // The oldest record goes, and its body with it.
    for (let i = MAX_CACHED_BODIES + 1; i <= MAX_RECORDS; i++) {
      agent.requestWillBeSent(`u${i}`, `https://e.com/${i}`);
    }
    expect(store.record(ids[0]!)).toBeUndefined();
    expect(await store.requestPostData(ids[0]!)).toEqual(refused("no such request"));

    // So 1 more body fits without pushing out the oldest one kept.
    await store.requestPostData(ids[MAX_CACHED_BODIES]!);
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
    expect(await store.requestPostData(ids[1]!)).toEqual(body("post of u1"));
    expect(app.request).toHaveBeenCalledTimes(MAX_CACHED_BODIES + 1);
  });
});

describe("iOS native network records: bodies of a closed connection", () => {
  /** A finished request and a streamed upload on CONN, whose connection is gone. */
  function closed() {
    const { app, store, agent } = bodyStore();
    agent.complete("done", "https://api.example.com/done");
    agent.requestWillBeSent("upload", "https://api.example.com/upload", {
      method: "POST",
      hasPostData: true,
    });
    app.setLive(undefined);
    return {
      app,
      store,
      read: async (): Promise<[NativeNetworkBody, NativeNetworkBody]> => [
        await store.responseBody(idOf(store, "done")),
        await store.requestPostData(idOf(store, "upload")),
      ],
    };
  }

  it.each<[string, ClosedConnectionCheck]>([
    ["a newer connection superseded it", { superseded: true }],
    ["the app no longer runs", { superseded: false, running: false }],
    [
      "another process of the app runs",
      { superseded: false, running: true, runningPid: 200, connectionPid: 100 },
    ],
  ])(
    "answers a body never read with the closed-connection reason, then once the host finds %s with the process-gone reason",
    async (_why, check) => {
      const { app, store, read } = closed();

      expect(await read()).toEqual([refused(CONNECTION_CLOSED), refused(CONNECTION_CLOSED)]);
      store.connectionClosed(CONN, check);
      expect(await read()).toEqual([refused(PROCESS_GONE), refused(PROCESS_GONE)]);
      expect(app.request).not.toHaveBeenCalled();
    }
  );

  it("keeps the closed-connection reason when the host finds the same process running, until a newer connection is live", async () => {
    const { app, store, read } = closed();

    store.connectionClosed(CONN, {
      superseded: false,
      running: true,
      runningPid: 100,
      connectionPid: 100,
    });
    expect(await read()).toEqual([refused(CONNECTION_CLOSED), refused(CONNECTION_CLOSED)]);

    app.setLive(OTHER_CONN);
    expect(await read()).toEqual([refused(PROCESS_GONE), refused(PROCESS_GONE)]);
    expect(app.request).not.toHaveBeenCalled();
  });

  it("keeps the process-gone reason once a newer connection was live, after it closed too", async () => {
    const { app, store, read } = closed();
    // The host could not tell whether the process ended.
    store.connectionClosed(CONN, { superseded: false });
    expect(await read()).toEqual([refused(CONNECTION_CLOSED), refused(CONNECTION_CLOSED)]);

    app.setLive(OTHER_CONN);
    expect(await read()).toEqual([refused(PROCESS_GONE), refused(PROCESS_GONE)]);
    app.setLive(undefined);
    store.connectionClosed(OTHER_CONN, { superseded: false });
    expect(await read()).toEqual([refused(PROCESS_GONE), refused(PROCESS_GONE)]);
    expect(app.request).not.toHaveBeenCalled();
  });

  it("answers process gone for a newer connection known only by its events, which closed before any read", async () => {
    const { app, store, read } = closed();
    store.connectionClosed(CONN, { superseded: false });

    agentOn(store, OTHER_CONN).complete("later", "https://api.example.com/later");
    expect(await read()).toEqual([refused(PROCESS_GONE), refused(PROCESS_GONE)]);
    expect(app.request).not.toHaveBeenCalled();
  });

  it("still serves the bodies read before the connection closed, and an inline request body", async () => {
    const { app, store, agent } = bodyStore();
    agent.complete("read", "https://api.example.com/read");
    agent.requestWillBeSent("streamed", "https://api.example.com/streamed", {
      method: "PUT",
      hasPostData: true,
    });
    agent.requestWillBeSent("inline", "https://api.example.com/inline", {
      method: "POST",
      postData: '{"a":1}',
    });
    agent.complete("unread", "https://api.example.com/unread");
    const [read, streamed, inline, unread] = ["read", "streamed", "inline", "unread"].map((rid) =>
      idOf(store, rid)
    );

    const response = store.responseBody(read!);
    await settle();
    app.sent[0]!.reply({ body: "kept", base64Encoded: false, wasTruncated: false });
    expect(await response).toEqual(body("kept"));
    const request = store.requestPostData(streamed!);
    await settle();
    app.sent[1]!.reply({ postData: "sent", base64Encoded: false });
    expect(await request).toEqual(body("sent"));

    app.setLive(undefined);
    store.connectionClosed(CONN, { superseded: true });

    expect(await store.responseBody(read!)).toEqual(body("kept"));
    expect(await store.requestPostData(streamed!)).toEqual(body("sent"));
    expect(await store.requestPostData(inline!)).toEqual(body('{"a":1}', { inlineChars: 7 }));
    expect(await store.responseBody(unread!)).toEqual(refused(PROCESS_GONE));
    expect(app.request).toHaveBeenCalledTimes(2);
  });

  it.each<[string, "response" | "post"]>([
    ["response", "response"],
    ["request", "post"],
  ])(
    "answers a %s body read open when its connection closes with the closed-connection reason, and keeps no reason",
    async (_body, kind) => {
      const { app, store, agent } = bodyStore();
      agent.requestWillBeSent("r", "https://api.example.com/a", {
        method: "POST",
        hasPostData: true,
      });
      agent.responseReceived("r", "https://api.example.com/a");
      agent.loadingFinished("r", 10, 5);
      const id = idOf(store, "r");
      const read = (): Promise<NativeNetworkBody> =>
        kind === "response" ? store.responseBody(id) : store.requestPostData(id);

      const open = read();
      await settle();
      app.setLive(undefined);
      app.sent[0]!.fail(closedError(app.sent[0]!.method));
      expect(await open).toEqual(refused(CONNECTION_CLOSED));

      store.connectionClosed(CONN, { superseded: true });
      expect(await read()).toEqual(refused(PROCESS_GONE));
      expect(app.request).toHaveBeenCalledTimes(1);
    }
  );
});

describe("iOS native network records: inline request body", () => {
  it("serves a request body that came with the request from the host, also after its connection closed", async () => {
    const { app, store, agent } = bodyStore();
    agent.requestWillBeSent("form", "https://api.example.com/form", {
      method: "POST",
      postData: "name=demo&x=1",
    });
    const id = idOf(store, "form");
    const expected: NativeNetworkBody = {
      available: true,
      body: "name=demo&x=1",
      base64Encoded: false,
      truncated: false,
      inlineChars: 13,
    };

    expect(store.record(id)!.request.hasPostData).toBe(true);
    expect(await store.requestPostData(id)).toEqual(expected);

    app.setLive(undefined);
    store.connectionClosed(CONN, { superseded: true });
    expect(await store.requestPostData(id)).toEqual(expected);
    expect(app.request).not.toHaveBeenCalled();
  });

  it(`keeps the first ${MAX_VALUE_CHARS} chars of a longer inline request body, with its whole length`, async () => {
    const { app, store, agent } = bodyStore();
    agent.requestWillBeSent("whole", "https://api.example.com/whole", {
      method: "POST",
      postData: "a".repeat(MAX_VALUE_CHARS),
    });
    agent.requestWillBeSent("long", "https://api.example.com/long", {
      method: "POST",
      postData: "a".repeat(MAX_VALUE_CHARS) + "b".repeat(10),
    });

    expect(await store.requestPostData(idOf(store, "whole"))).toEqual(
      body("a".repeat(MAX_VALUE_CHARS), { inlineChars: MAX_VALUE_CHARS })
    );
    expect(await store.requestPostData(idOf(store, "long"))).toEqual(
      body("a".repeat(MAX_VALUE_CHARS), { truncated: true, inlineChars: MAX_VALUE_CHARS + 10 })
    );
    expect(app.request).not.toHaveBeenCalled();
  });

  it("holds only the kept start of a large inline request body in memory", () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const usedHeap = (): number => {
      gc();
      return process.memoryUsage().heapUsed;
    };
    const { store, agent } = bodyStore();
    const before = usedHeap();

    for (let i = 0; i < 20; i++) {
      agent.requestWillBeSent(`big-${i}`, `https://e.com/${i}`, {
        method: "POST",
        postData: String(i).padEnd(4 * 1024 * 1024, "p"),
      });
    }

    // 20 bodies of 4 MiB each, of which the store keeps 20 starts of 64 KiB.
    expect(store.records(8081)).toHaveLength(20);
    expect(usedHeap() - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("counts the kept start of an inline request body toward the size budget", async () => {
    const { store, agent } = bodyStore();
    const postData = "p".repeat(2 * MAX_VALUE_CHARS);
    const send = (i: number): void =>
      agent.requestWillBeSent(`post-${i}`, `https://e.com/${String(i).padStart(4, "0")}`, {
        method: "POST",
        postData,
      });

    send(0);
    const strings = recordSize(store.record(idOf(store, "post-0"))!);
    const fit = Math.floor(RECORD_CHARS_BUDGET / (strings + MAX_VALUE_CHARS));
    // Without the body the count bound would bind first, and with the whole
    // body half as many would fit.
    expect(Math.floor(RECORD_CHARS_BUDGET / strings)).toBeGreaterThan(MAX_RECORDS);
    expect(Math.floor(RECORD_CHARS_BUDGET / (strings + postData.length))).toBeLessThan(fit - 1);

    for (let i = 1; i < fit; i++) send(i);
    expect(store.records(8081)).toHaveLength(fit);
    const oldest = idOf(store, "post-0");

    send(fit);
    expect(store.records(8081)).toHaveLength(fit);
    expect(store.records(8081)[0]!.layerId).toBe("post-1");
    expect(await store.requestPostData(oldest)).toEqual(refused("no such request"));
  });
});
