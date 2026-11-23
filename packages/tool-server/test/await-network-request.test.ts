import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createContext, runInContext, type Context } from "node:vm";
import {
  FAILURE_CODES,
  Registry,
  TypedEventEmitter,
  getFailureSignal,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { createAwaitNetworkRequestTool } from "../src/tools/await-network-request";
import {
  mismatches,
  type RequestCriteria,
  type WaitRecord,
} from "../src/tools/await-network-request/match";
import {
  forgetJsCapturesOf,
  jsCapturePayload,
  setJsCapture,
  type JsCaptureMark,
} from "../src/blueprints/network-inspector";
import { nativeDevtoolsRef } from "../src/blueprints/native-devtools";
import { STOPPED_BEFORE_FINISH } from "../src/blueprints/android-network-inspector";
import { chromiumCdpRef } from "../src/blueprints/chromium-cdp";
import { createNetworkManager } from "../src/chromium-server/network";
import { noteCaptureStart } from "../src/tools/network/network-capture";
import { createNetworkCaptureStartTool } from "../src/tools/network/network-capture-start";
import type { CDPClient } from "../src/utils/debugger/cdp-client";
import { NETWORK_INTERCEPTOR_SCRIPT } from "../src/utils/debugger/scripts/network-interceptor";
import type { NativeNetworkRecord, NativeRecordState } from "../src/utils/native-network-record";
import { resolveDevice } from "../src/utils/device-info";
import { AWAIT_NETWORK_REQUEST_TOOL_ID } from "../src/utils/wait-result";

const IOS = "11111111-2222-3333-4444-555555555555";
const CHROMIUM = "chromium-cdp-9222";
const APP = "com.example.shop";
/** The Metro port of the JS capture's payload. */
const PORT = 8081;
/** The Metro port a native start kept with its mark: the store is read with it. */
const MARK_PORT = 8190;
const API = "https://api.test";

interface WaitResult {
  success: boolean;
  elapsed: number;
  match?: WaitRecord;
  note?: string;
  cause?: string;
  nearMisses?: Array<WaitRecord & { mismatch: string[] }>;
  layers?: Array<{ layer: string; armed: boolean; readable: boolean; stopped?: true }>;
}

// ── The iOS native layer ────────────────────────────────────────────────────

interface RecordSpec {
  url: string;
  status?: number;
  state?: NativeRecordState;
  errorText?: string;
}

/** The simulator's native-devtools service, with one app's records, numbered across the tool-server. */
class FakeIos {
  mark: { lastRecord: number; metroPort: number } | undefined;
  stopped = false;
  armed = true;
  readonly records: NativeNetworkRecord[] = [];
  /** What each read of the records asked for. */
  readonly asked: Array<{ port: number; includeHidden?: boolean }> = [];

  add(n: number, { url, status, state = "complete", errorText }: RecordSpec): void {
    this.records.push({
      id: `ios-t7-${n}`,
      layer: "ios-native",
      layerId: String(n),
      connection: 1,
      state,
      request: { url: `${API}${url}`, method: "GET", headers: {} },
      ...(status !== undefined
        ? { response: { url, status, statusText: "", headers: {}, mimeType: "text/plain" } }
        : {}),
      timing: { startedAt: 0 },
      ...(errorText !== undefined ? { errorText } : {}),
    });
  }

  networkCaptureMark(bundleId: string) {
    return bundleId === APP ? this.mark : undefined;
  }
  isNetworkCaptureStopped(): boolean {
    return this.stopped;
  }
  networkRecords() {
    return {
      state: () => ({ armed: this.armed, ...(this.armed ? {} : { note: "not connected yet" }) }),
      records: (port: number, options?: { includeHidden?: boolean }) => {
        this.asked.push({ port, ...options });
        return this.records;
      },
    };
  }
}

// ── A Chromium tab: the real network manager, fed CDP events ────────────────

class FakeTab {
  private readonly cdp = { events: new EventEmitter(), send: async () => ({}) };
  readonly network = createNetworkManager({ cdp: this.cdp as unknown as CDPClient });

  private emit(method: string, params: Record<string, unknown>): void {
    this.cdp.events.emit("event", method, params);
  }
  /** The tab sends a request, gets a 200 for it, and maybe reads its body to the end. */
  request(requestId: string, path: string, finish = true): void {
    this.emit("Network.requestWillBeSent", {
      requestId,
      request: { method: "GET", url: `${API}${path}` },
      timestamp: 1,
    });
    this.emit("Network.responseReceived", { requestId, response: { status: 200 } });
    if (finish) this.emit("Network.loadingFinished", { requestId, timestamp: 1.25 });
  }
}

// ── The app's JS runtime: argent's scripts run in a real JS context ─────────

/** React Native's XMLHttpRequest, as much of it as the interceptor patches. */
const XHR_BUNDLE = `globalThis.XMLHttpRequest = function XMLHttpRequest() {};
  ['open', 'setRequestHeader', 'send', 'abort', 'addEventListener', 'getAllResponseHeaders']
    .forEach(function(name) { XMLHttpRequest.prototype[name] = function() { return ''; }; });`;

class FakeRuntime {
  context: Context = createContext({});
  /** The app sends a request right after an install, as it goes on between two polls. */
  afterInstall: (() => void) | undefined;
  /** How long each evaluate takes to answer, as on a busy JS thread. */
  latencyMs = 0;

  constructor() {
    runInContext(XHR_BUNDLE, this.context);
    runInContext(NETWORK_INTERCEPTOR_SCRIPT, this.context);
  }

  get token(): string {
    return (this.context as { __argent_network_install: string }).__argent_network_install;
  }

  /** A request the interceptor logged, with the id it gave. */
  push(id: number, url: string, status = 200): void {
    (this.context as { __argent_network_log: unknown[] }).__argent_network_log.push({
      id,
      requestId: `rn-net-${id}`,
      state: "finished",
      request: { method: "GET", url: `${API}${url}`, headers: {} },
      response: { status, headers: {} },
    });
  }

  evaluate(expr: string): Promise<unknown> {
    const answer = runInContext(expr, this.context);
    if (expr === NETWORK_INTERCEPTOR_SCRIPT) this.afterInstall?.();
    if (this.latencyMs === 0) return Promise.resolve(answer);
    return new Promise((resolve) => setTimeout(() => resolve(answer), this.latencyMs));
  }
}

/** What Metro serves per `<port>:<device>`. */
const metro = new Map<string, FakeRuntime>();
let debuggerFactoryCalls = 0;

// ── The registry ────────────────────────────────────────────────────────────

let registry: Registry;
let ios: FakeIos;
let tab: FakeTab;

function fakeBlueprint(
  namespace: string,
  api: (payload: string) => unknown
): ServiceBlueprint<unknown, string> {
  return {
    namespace,
    getURN: (payload) => `${namespace}:${payload}`,
    factory: async (_deps, payload) => ({
      api: api(payload),
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    }),
  };
}

beforeEach(() => {
  registry = new Registry();
  ios = new FakeIos();
  tab = new FakeTab();
  registry.registerBlueprint(fakeBlueprint("NativeDevtools", () => ios));
  registry.registerBlueprint(fakeBlueprint("ChromiumCdp", () => ({ server: tab })));
  registry.registerBlueprint(
    fakeBlueprint("JsRuntimeDebugger", (payload) => {
      debuggerFactoryCalls++;
      const runtime = metro.get(payload)!;
      const cdp = {
        evaluate: (expr: string) => runtime.evaluate(expr),
        events: new EventEmitter(),
      };
      return { port: PORT, cdp, runtimeApp: { appId: APP } };
    })
  );
  registry.registerTool(createAwaitNetworkRequestTool(registry));
  metro.clear();
  debuggerFactoryCalls = 0;
  forgetJsCapturesOf();
});

afterEach(async () => {
  await registry.dispose();
  forgetJsCapturesOf();
});

/** network-capture-start on the iOS native layer: a mark, on a service that runs. */
async function startIos(udid = IOS): Promise<void> {
  ios.mark = { lastRecord: 10, metroPort: MARK_PORT };
  await registry.resolveService(nativeDevtoolsRef(resolveDevice(udid)).urn);
}

/** network-capture-start or -stop on the JS layer: the stored capture, with its mark. */
async function startJs(
  runtime: FakeRuntime,
  mark: JsCaptureMark,
  { intent = "started", udid = IOS }: { intent?: "started" | "stopped"; udid?: string } = {}
): Promise<void> {
  const payload = jsCapturePayload(PORT, udid);
  metro.set(payload, runtime);
  setJsCapture(payload, { bundleId: APP, intent, mark, installed: true });
  // A stop pauses the interceptor; a stopped capture is read only while its debugger runs.
  if (intent === "stopped") {
    runInContext("__argent_network_paused = true", runtime.context);
    await registry.resolveService(`JsRuntimeDebugger:${payload}`);
  }
}

function wait(params: Record<string, unknown> & { url: string }, udid = IOS) {
  return registry.invokeTool<WaitResult>(AWAIT_NETWORK_REQUEST_TOOL_ID, {
    udid,
    bundleId: APP,
    pollIntervalMs: 50,
    timeoutMs: 150,
    ...params,
  });
}

const criteria = (wanted: Partial<RequestCriteria>): RequestCriteria => ({
  url: "/v1/login",
  urlMatch: "contains",
  outcome: "complete",
  ...wanted,
});
const record = (fields: Partial<WaitRecord>): WaitRecord => ({
  id: "r",
  layer: "ios-native",
  method: "GET",
  url: `${API}/v1/login`,
  state: "complete",
  ...fields,
});

describe("await-network-request", () => {
  it("matches a request after the mark on the native layer, read with the mark's Metro port", async () => {
    await startIos();
    ios.add(9, { url: "/v1/login", status: 200 });
    ios.add(11, { url: "/v1/login", status: 201 });

    const result = await wait({ url: "/v1/login" });

    expect(result.match).toEqual({
      id: "ios-t7-11",
      layer: "ios-native",
      method: "GET",
      url: `${API}/v1/login`,
      status: 201,
      state: "complete",
    });
    // A `clear` of the listing hides nothing from the wait.
    expect(ios.asked[0]).toEqual({ port: MARK_PORT, includeHidden: true });
  });

  it("matches a JS request after the mark's id, by its request id", async () => {
    const runtime = new FakeRuntime();
    runtime.push(1, "/v1/login");
    await startJs(runtime, { install: runtime.token, lastId: 1 });
    runtime.push(2, "/v1/login", 201);

    const result = await wait({ url: "/v1/login" });

    expect(result.match).toMatchObject({ id: "rn-net-2", layer: "js", status: 201 });
  });

  it("matches a Chromium request created after the start, once its body ended", async () => {
    tab.request("before", "/v1/login", false);
    tab.network.startCapture();
    await registry.resolveService(chromiumCdpRef(resolveDevice(CHROMIUM)).urn);
    tab.request("before", "/v1/login");
    tab.request("after", "/v1/login");

    const result = await wait({ url: "/v1/login" }, CHROMIUM);

    expect(result.match).toMatchObject({ id: "after", layer: "chromium", state: "complete" });
  });

  it("compares the URL as contains, equals or matches", () => {
    const url = `${API}/v1/Users/42?x=1`;
    const missed = (wanted: Partial<RequestCriteria>) =>
      mismatches(criteria(wanted), record({ url }));
    expect(missed({ url: "/users/42" })).toEqual([]);
    expect(missed({ url: `${API}/v1/users/42`, urlMatch: "equals" })).toEqual(["url"]);
    expect(missed({ url: url.toUpperCase(), urlMatch: "equals" })).toEqual([]);
    expect(missed({ url: "/Users/\\d+", urlMatch: "matches" })).toEqual([]);
    expect(missed({ url: "/users/\\d+", urlMatch: "matches" })).toEqual(["url"]);
  });

  it("matches an exact status or a status class", () => {
    expect(mismatches(criteria({ status: 201 }), record({ status: 201 }))).toEqual([]);
    expect(mismatches(criteria({ status: 200 }), record({ status: 201 }))).toEqual(["status"]);
    expect(mismatches(criteria({ status: "2xx" }), record({ status: 204 }))).toEqual([]);
    expect(mismatches(criteria({ status: "4xx" }), record({ status: 500 }))).toEqual(["status"]);
    expect(mismatches(criteria({ status: "2xx" }), record({}))).toEqual(["status"]);
  });

  it("takes the outcome asked for, and never a request whose end argent lost", async () => {
    await startIos();
    ios.add(11, { url: "/v1/sync", state: "failed", errorText: "timed out" });
    ios.add(12, { url: "/v1/stop", state: "failed", errorText: STOPPED_BEFORE_FINISH });
    ios.add(13, { url: "/v1/stream", state: "headers", status: 200 });

    // A response whose body has not ended is still in flight.
    expect((await wait({ url: "/v1/stream" })).success).toBe(false);
    expect((await wait({ url: "/v1/sync" })).success).toBe(false);
    expect((await wait({ url: "/v1/sync", outcome: "failed" })).match?.id).toBe("ios-t7-11");
    expect((await wait({ url: "/v1/sync", outcome: "any" })).match?.id).toBe("ios-t7-11");
    // The same failed record, but failed by argent's own stop: its end is unknown.
    expect((await wait({ url: "/v1/stop", outcome: "failed" })).success).toBe(false);
    expect((await wait({ url: "/v1/stop", outcome: "any" })).success).toBe(false);
  });

  it("fails with NETWORK_CAPTURE_NOT_STARTED without a mark, and creates no service", async () => {
    const resolve = vi.spyOn(registry, "resolveService");

    const err = await wait({ url: "/v1/login" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_NOT_STARTED);
    expect((err as Error).message).toContain(`Call network-capture-start for ${APP}`);
    expect(resolve).not.toHaveBeenCalled();
    expect([...registry.getSnapshot().services.keys()]).toEqual([]);
    expect(debuggerFactoryCalls).toBe(0);
  });

  it("is unmet when an armed layer was read, and unreadable when no layer was armed", async () => {
    await startIos();
    ios.add(11, { url: "/v1/login", status: 500 });

    const unmet = await wait({ url: "/v1/login", status: 200 });
    expect(unmet.success).toBe(false);
    expect(unmet.cause).toBe("unmet");
    expect(unmet.note).toContain(
      'No request since network-capture-start matched within this 150 ms wait (wanted: URL containing "/v1/login", status 200, complete). ' +
        "Requests since the start: ios-native 1."
    );
    expect(unmet.layers).toEqual([
      { layer: "ios-native", armed: true, readable: true, requests: 1 },
    ]);

    ios.armed = false;
    const unreadable = await wait({ url: "/v1/login", status: 200 });
    expect(unreadable.cause).toBe("unreadable");
    expect(unreadable.layers).toEqual([
      { layer: "ios-native", armed: false, readable: true, requests: 1, note: "not connected yet" },
    ]);
  });

  it("returns at once when every marked layer is stopped and holds no open request", async () => {
    await startIos();
    ios.stopped = true;
    ios.add(11, { url: "/v1/login", status: 500 });
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: runtime.token, lastId: 0 }, { intent: "stopped" });

    const result = await wait({ url: "/v1/login", status: 200, timeoutMs: 5000 });

    expect(result.cause).toBe("unmet");
    expect(result.elapsed).toBeLessThan(1000);
    expect(result.note).toContain("capture is stopped on every marked layer");
    expect(result.layers?.map(({ layer, stopped }) => ({ layer, stopped }))).toEqual([
      { layer: "ios-native", stopped: true },
      { layer: "js", stopped: true },
    ]);
  });

  it("reads only the layers of the last start: start both, stop both, start js", async () => {
    // A device of its own: the last start's layers stay noted for the file.
    const udid = "33333333-4444-5555-6666-777777777777";
    const runtime = new FakeRuntime();
    await startIos(udid);
    await startJs(runtime, { install: runtime.token, lastId: 0 }, { udid });
    noteCaptureStart(
      udid,
      APP,
      [
        { layer: "js", armed: true },
        { layer: "ios-native", armed: true },
      ],
      10
    );
    ios.add(11, { url: "/v1/login", status: 200 });
    ios.stopped = true;
    await startJs(runtime, { install: runtime.token, lastId: 0 }, { udid });
    noteCaptureStart(udid, APP, [{ layer: "js", armed: true }], 11);

    const result = await wait({ url: "/v1/login" }, udid);

    // The native record is from the first start's window.
    expect(result.success).toBe(false);
    expect(result.layers?.map(({ layer }) => layer)).toEqual(["js"]);
    expect(ios.asked).toEqual([]);
  });

  it("reads a native layer that a js start left running only after that start", async () => {
    const udid = "33333333-4444-5555-6666-000000000001";
    await startIos(udid);
    ios.add(11, { url: "/v1/login", status: 200 });
    // A start with layer js, when the last native record was 11.
    noteCaptureStart(udid, APP, [{ layer: "js", armed: true }], 11);

    expect((await wait({ url: "/v1/login" }, udid)).cause).toBe("unmet");
    ios.add(12, { url: "/v1/login", status: 200 });
    expect((await wait({ url: "/v1/login" }, udid)).match?.id).toBe("ios-t7-12");
  });

  it("reads the JS layer only when the last start named it", async () => {
    const udid = "33333333-4444-5555-6666-000000000002";
    const runtime = new FakeRuntime();
    await startIos(udid);
    await startJs(runtime, { install: runtime.token, lastId: 0 }, { udid });
    runtime.push(1, "/v1/cart");
    noteCaptureStart(udid, APP, [{ layer: "ios-native", armed: true }], 10);

    const result = await wait({ url: "/v1/cart" }, udid);

    expect(result.success).toBe(false);
    expect(result.layers?.map(({ layer }) => layer)).toEqual(["ios-native"]);
  });

  it("keeps no JS mark from a start whose read of the mark failed", async () => {
    const udid = "33333333-4444-5555-6666-000000000003";
    registry.registerTool(createNetworkCaptureStartTool(registry));
    const runtime = new FakeRuntime();
    metro.set(jsCapturePayload(PORT, udid), runtime);
    runtime.push(1, "/v1/login");
    // The runtime does not answer the start's read of the mark, then answers again.
    vi.spyOn(runtime, "evaluate").mockRejectedValueOnce(new Error("timed out after 5000 ms"));
    await registry.invokeTool("network-capture-start", { udid, bundleId: APP, layer: "js" });

    const err = await wait({ url: "/v1/login" }, udid).catch((e: unknown) => e);

    // Without a mark, the request logged before the start does not match.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_NOT_STARTED);
  });

  it("keeps a JS layer armed at the timeout when the deadline cut its last read short", async () => {
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: runtime.token, lastId: 0 });
    runtime.push(1, "/v1/other");
    // Reads at 0 and 500 ms answer 300 ms later; the one at 1000 ms has 100 ms left.
    runtime.latencyMs = 300;

    const result = await wait({ url: "/v1/login", pollIntervalMs: 200, timeoutMs: 1100 });

    // The read at 800 ms lies inside the dark tail of 2 poll intervals.
    expect(result.cause).toBe("unmet");
    expect(result.layers).toEqual([{ layer: "js", armed: true, readable: true, requests: 1 }]);
    expect(result.note).not.toContain("did not answer");
  });

  it("reads the native layer at the deadline after a JS read that ran into it", async () => {
    await startIos();
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: runtime.token, lastId: 0 });
    runtime.evaluate = () => new Promise(() => {});
    // After the last full poll, at 1500 ms, and before the deadline.
    setTimeout(() => ios.add(11, { url: "/v1/login", status: 200 }), 1900);

    const result = await wait({ url: "/v1/login", pollIntervalMs: 500, timeoutMs: 2000 });

    expect(result.match?.id).toBe("ios-t7-11");
  });

  it("is unmet, not unreadable, when the only layer is a JS runtime that answers in 600 ms", async () => {
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: runtime.token, lastId: 0 });
    runtime.latencyMs = 600;

    // Reads end at 600 and 1600 ms; the one from 2000 ms runs into the deadline.
    const result = await wait({ url: "/v1/login", pollIntervalMs: 400, timeoutMs: 2600 });

    expect(result.cause).toBe("unmet");
  });

  it("keeps each layer's note on a success, such as a reload that left requests out", async () => {
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: "a-context-before-the-reload", lastId: 50 });
    runtime.push(1, "/v1/config");

    const result = await wait({ url: "/v1/config" });

    expect(result.match?.id).toBe("rn-net-1");
    expect(result.note).toBe(
      "js: the app's JS runtime reloaded after the start, so its requests between the reload and the interceptor's reinstall are missing"
    );
  });
});

describe("diagnostics: near misses and JS reinstall", () => {
  it("lists the closest requests and the criteria each missed, also in the note", async () => {
    await startIos();
    ios.add(11, { url: "/v1/login", status: 500 });
    ios.add(12, { url: "/v1/other", status: 200 });
    ios.add(13, { url: "/v1/stop", state: "failed", errorText: STOPPED_BEFORE_FINISH });

    const result = await wait({ url: "/v1/login", status: 200 });

    // A matching URL first, then the fewest misses; a lost request shows as lost.
    expect(result.nearMisses?.map(({ id, state, mismatch }) => ({ id, state, mismatch }))).toEqual([
      { id: "ios-t7-11", state: "complete", mismatch: ["status"] },
      { id: "ios-t7-12", state: "complete", mismatch: ["url"] },
      { id: "ios-t7-13", state: "lost", mismatch: ["url", "status", "outcome"] },
    ]);
    expect(result.note).toContain(
      `Nearest: GET ${API}/v1/login 500 complete [ios-native ios-t7-11] (mismatch: status); `
    );
  });

  it("installs the interceptor in a context that reloaded without it, and reads it next poll", async () => {
    const runtime = new FakeRuntime();
    await startJs(runtime, { install: runtime.token, lastId: 0 });
    // A reload that kept the CDP connection: a new context, whose bundle ran.
    runtime.context = createContext({});
    runInContext(XHR_BUNDLE, runtime.context);
    runtime.afterInstall = () => runtime.push(1, "/v1/login");

    const result = await wait({ url: "/v1/login", timeoutMs: 2000 });

    expect(result.match?.id).toBe("rn-net-1");
    expect(
      typeof (runtime.context as { __argent_network_mark?: unknown }).__argent_network_mark
    ).toBe("function");
  });
});
