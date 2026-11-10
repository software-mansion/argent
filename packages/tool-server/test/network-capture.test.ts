import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createContext, runInContext, type Context } from "node:vm";
import {
  FAILURE_CODES,
  FailureError,
  Registry,
  ServiceState,
  TypedEventEmitter,
  getFailureSignal,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import {
  findJsCapture,
  forgetJsCapturesOf,
  jsCapture,
  jsCapturePayload,
  jsCapturesOn,
  networkInspectorBlueprint,
} from "../src/blueprints/network-inspector";
import type {
  NativeDevtoolsApi,
  NativeDevtoolsAppState,
  NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import type {
  AndroidCaptureStart,
  AndroidNetworkInspectorApi,
} from "../src/blueprints/android-network-inspector";
import type { IosNetworkRecords } from "../src/blueprints/ios-network-records";
import type { NativeNetworkRecord } from "../src/utils/native-network-record";
import { createNetworkCaptureStartTool } from "../src/tools/network/network-capture-start";
import { createNetworkCaptureStopTool } from "../src/tools/network/network-capture-stop";
import type {
  CaptureResult,
  StartedLayer,
  StoppedLayer,
} from "../src/tools/network/network-capture";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";
import {
  NETWORK_CAPTURE_END_SCRIPT,
  NETWORK_CAPTURE_MARK_SCRIPT,
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkCaptureControlScript,
} from "../src/utils/debugger/scripts/network-interceptor";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

const IOS_UDID = "11111111-2222-3333-4444-555555555555";
const SERIAL = "emulator-5554";
const APP = "com.example.shop";
const OTHER = "com.example.other";
const PORT = 8081;
const NOT_STARTED = "capture was not started for this app";
const METRO_DOWN = `Metro is not running on port ${PORT}; start it, or pass the port of the app's Metro`;

// ── The app's JS runtime ────────────────────────────────────────────────────

/** React Native's XMLHttpRequest, as much of it as the interceptor patches. */
const XHR_BUNDLE = `
  globalThis.XMLHttpRequest = function XMLHttpRequest() {};
  XMLHttpRequest.prototype.open = function() {};
  XMLHttpRequest.prototype.setRequestHeader = function() {};
  XMLHttpRequest.prototype.send = function() {};
  XMLHttpRequest.prototype.abort = function() {};
  XMLHttpRequest.prototype.addEventListener = function() {};
  XMLHttpRequest.prototype.getAllResponseHeaders = function() { return ''; };
`;

type ScriptName = "mark" | "resume" | "pause" | "end" | "install" | "read" | "other";

function scriptName(expr: string): ScriptName {
  if (expr === NETWORK_CAPTURE_MARK_SCRIPT) return "mark";
  if (expr === makeNetworkCaptureControlScript(false)) return "resume";
  if (expr === makeNetworkCaptureControlScript(true)) return "pause";
  if (expr === NETWORK_CAPTURE_END_SCRIPT) return "end";
  if (expr === NETWORK_INTERCEPTOR_SCRIPT) return "install";
  if (expr.includes("__argent_network_log")) return "read";
  return "other";
}

/** An app's JS runtime behind Metro. argent's scripts run in a real JS context of it. */
class FakeRuntime {
  private readonly context: Context = createContext({});
  /** The scripts argent evaluated in it, in order. */
  readonly evaluated: ScriptName[] = [];

  constructor(
    readonly appId: string | undefined,
    { loaded = true }: { loaded?: boolean } = {}
  ) {
    if (loaded) this.loadBundle();
  }

  /** The app's bundle runs, which sets up XMLHttpRequest. */
  loadBundle(): void {
    runInContext(XHR_BUNDLE, this.context);
  }

  /** The app sends a request. */
  send(path: string): void {
    runInContext(
      `(function() { var x = new XMLHttpRequest(); x.open('GET', 'https://api.test${path}'); x.send(); })()`,
      this.context
    );
  }

  evaluate(expr: string): unknown {
    this.evaluated.push(scriptName(expr));
    return runInContext(expr, this.context);
  }

  get paused(): unknown {
    return (this.context as { __argent_network_paused?: unknown }).__argent_network_paused;
  }
}

type FailureCode = (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES];

/** What Metro answers per `<port>:<device>`: a runtime, a failure, or nothing (Metro is down). */
const metro = new Map<string, FakeRuntime | FailureCode>();

function serve(port: number, device: string, answer: FakeRuntime | FailureCode | undefined): void {
  const payload = jsCapturePayload(port, device);
  if (answer === undefined) metro.delete(payload);
  else metro.set(payload, answer);
}

/** Metro serves something else now, as after a reload or a relaunch: the debugger reconnects. */
async function reconnect(
  port: number,
  device: string,
  answer: FakeRuntime | FailureCode | undefined
): Promise<void> {
  serve(port, device, answer);
  const urn = `JsRuntimeDebugger:${jsCapturePayload(port, device)}`;
  if (registry.getSnapshot().services.has(urn)) await registry.disposeService(urn);
}

function notReached(code: FailureCode, message: string): FailureError {
  return new FailureError(message, {
    error_code: code,
    failure_stage: "test_metro",
    failure_area: "tool_server",
    error_kind: "network",
  });
}

/** The JS runtime debugger, reaching whatever {@link metro} serves for its payload. */
const fakeDebuggerBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "JsRuntimeDebugger",
  getURN: (payload) => `JsRuntimeDebugger:${payload}`,
  async factory(_deps, payload) {
    const port = Number(payload.slice(0, payload.indexOf(":")));
    const answer = metro.get(payload);
    if (answer === undefined) {
      throw notReached(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING, `nothing answers on port ${port}`);
    }
    if (typeof answer === "string") throw notReached(answer, `Metro on port ${port}: ${answer}`);
    const cdp = {
      evaluate: async (expr: string) => answer.evaluate(expr),
      events: new EventEmitter(),
      isConnected: () => true,
    };
    return {
      api: {
        port,
        cdp,
        runtimeApp: answer.appId === undefined ? undefined : { appId: answer.appId },
      },
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

// ── The native layers ───────────────────────────────────────────────────────

/** The native layers number their records across the tool-server. */
let lastRecord = 0;

type CaptureMark = { lastRecord: number; metroPort: number };

/** The iOS simulator's native-devtools service, as the capture tools use it. */
class FakeIos implements Pick<
  NativeDevtoolsApi,
  | "armsEnv"
  | "getInitFailure"
  | "ensureEnvReady"
  | "isConnected"
  | "appConnectionState"
  | "startNetworkCapture"
  | "stopNetworkCapture"
  | "isNetworkCaptureStarted"
  | "isNetworkCaptureStopped"
  | "networkCaptureMark"
  | "networkRecords"
> {
  readonly connected = new Set<string>();
  armsEnv = true;
  /** How the host reads an app that is not connected. */
  appState: NativeDevtoolsAppState = "not_running";
  /** What `ensureEnvReady` rejects with. */
  envError: Error | undefined;
  /** A connected app acknowledges Network.enable. */
  acknowledges = true;
  /** The note the app's records keep. */
  note: string | undefined;
  stopAnswer: { confirmed: boolean; reason?: string } = { confirmed: true };
  /** What the tools asked of the service, in order. */
  readonly calls: string[] = [];
  private readonly started = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly marks = new Map<string, CaptureMark>();
  private readonly held = new Map<string, number>();

  /** The app sends a request, which the service records while capture is started. */
  record(bundleId: string): void {
    if (!this.started.has(bundleId)) return;
    lastRecord++;
    this.held.set(bundleId, (this.held.get(bundleId) ?? 0) + 1);
  }

  getInitFailure(): NativeDevtoolsInitFailure | null {
    return null;
  }
  async ensureEnvReady(): Promise<void> {
    if (this.envError) throw this.envError;
  }
  isConnected(bundleId: string): boolean {
    return this.connected.has(bundleId);
  }
  async appConnectionState(bundleId: string): Promise<NativeDevtoolsAppState> {
    return this.connected.has(bundleId) ? "connected" : this.appState;
  }
  async startNetworkCapture(bundleId: string, metroPort: number, wait = 0): Promise<boolean> {
    this.calls.push(`start ${bundleId} ${metroPort} ${wait}`);
    this.stopped.delete(bundleId);
    this.started.add(bundleId);
    this.marks.set(bundleId, { lastRecord, metroPort });
    return this.connected.has(bundleId) && this.acknowledges;
  }
  async stopNetworkCapture(bundleId: string): Promise<{ confirmed: boolean; reason?: string }> {
    this.calls.push(`stop ${bundleId}`);
    this.started.delete(bundleId);
    this.stopped.add(bundleId);
    return this.stopAnswer;
  }
  isNetworkCaptureStarted(bundleId: string): boolean {
    return this.started.has(bundleId);
  }
  isNetworkCaptureStopped(bundleId: string): boolean {
    return this.stopped.has(bundleId);
  }
  networkCaptureMark(bundleId: string): CaptureMark | undefined {
    return this.marks.get(bundleId);
  }
  networkRecords(bundleId: string): IosNetworkRecords | undefined {
    if (!this.held.has(bundleId) && !this.connected.has(bundleId)) return undefined;
    const count = this.held.get(bundleId) ?? 0;
    return {
      state: () => ({ note: this.note }),
      records: () => Array.from({ length: count }, () => ({}) as NativeNetworkRecord),
    } as unknown as IosNetworkRecords;
  }
}

/** One app's Android network inspector, as the capture tools use it. */
class FakeAndroid implements Pick<
  AndroidNetworkInspectorApi,
  | "packageName"
  | "startCapture"
  | "stopCapture"
  | "isStarted"
  | "isStopped"
  | "captureMark"
  | "records"
> {
  /** What the tools asked of the inspector, in order. */
  readonly calls: string[] = [];
  /** What a start finds once it ran its attach. */
  startAnswer: () => AndroidCaptureStart | Promise<AndroidCaptureStart> = () => ({ armed: true });
  stopAnswer: { confirmed: boolean; reason?: string } = { confirmed: true };
  private started = false;
  private stopped = false;
  private mark: CaptureMark | undefined;
  private held = 0;

  constructor(readonly packageName: string) {}

  /** The app sends a request, which the inspector records while capture is started. */
  record(): void {
    if (!this.started) return;
    lastRecord++;
    this.held++;
  }

  async startCapture(metroPort: number): Promise<AndroidCaptureStart> {
    this.calls.push(`start ${metroPort}`);
    const found = { stopped: this.stopped, mark: this.mark };
    this.stopped = false;
    this.mark = { lastRecord, metroPort };
    const answer = await this.startAnswer();
    // An unavailable start keeps the stop and the mark it found.
    if (answer.unavailable) ({ stopped: this.stopped, mark: this.mark } = found);
    else this.started = true;
    return answer;
  }
  async stopCapture(): Promise<{ confirmed: boolean; reason?: string }> {
    this.calls.push("stop");
    this.started = false;
    this.stopped = true;
    return this.stopAnswer;
  }
  isStarted(): boolean {
    return this.started;
  }
  isStopped(): boolean {
    return this.stopped;
  }
  captureMark(): CaptureMark | undefined {
    return this.mark;
  }
  records(): NativeNetworkRecord[] {
    return Array.from({ length: this.held }, () => ({}) as NativeNetworkRecord);
  }
}

let ios: FakeIos;
const android = new Map<string, FakeAndroid>();
let androidFactoryCalls = 0;

function androidFor(packageName: string): FakeAndroid {
  let fake = android.get(packageName);
  if (!fake) {
    fake = new FakeAndroid(packageName);
    android.set(packageName, fake);
  }
  return fake;
}

const fakeNativeDevtoolsBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "NativeDevtools",
  getURN: (payload) => `NativeDevtools:${payload}`,
  async factory() {
    return { api: ios, dispose: async () => {}, events: new TypedEventEmitter<ServiceEvents>() };
  },
};

const fakeAndroidInspectorBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "AndroidNetworkInspector",
  getURN: (payload) => `AndroidNetworkInspector:${payload}`,
  async factory(_deps, _payload, options) {
    androidFactoryCalls++;
    const { packageName } = options as { packageName: string };
    return {
      api: androidFor(packageName),
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

// ── The tools ───────────────────────────────────────────────────────────────

let registry: Registry;

beforeEach(() => {
  registry = new Registry();
  registry.registerBlueprint(fakeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
  registry.registerBlueprint(fakeNativeDevtoolsBlueprint);
  registry.registerBlueprint(fakeAndroidInspectorBlueprint);
  registry.registerTool(createNetworkCaptureStartTool(registry));
  registry.registerTool(createNetworkCaptureStopTool(registry));
  registry.registerTool(networkLogsTool);
  registry.registerTool(networkRequestTool);
  registry.registerTool(createStopAllSimulatorServersTool(registry));
  metro.clear();
  forgetJsCapturesOf();
  ios = new FakeIos();
  android.clear();
  androidFactoryCalls = 0;
  __primeDepCacheForTests(["xcrun", "adb"]);
});

afterEach(async () => {
  await registry.dispose();
  forgetJsCapturesOf();
  __resetDepCacheForTests();
});

function start(udid: string, bundleId: string, port?: number) {
  return registry.invokeTool<CaptureResult<StartedLayer>>("network-capture-start", {
    udid,
    bundleId,
    ...(port !== undefined ? { port } : {}),
  });
}

function stop(udid: string, bundleId: string, port?: number) {
  return registry.invokeTool<CaptureResult<StoppedLayer>>("network-capture-stop", {
    udid,
    bundleId,
    ...(port !== undefined ? { port } : {}),
  });
}

function stopAll(devices: string[], signal?: AbortSignal) {
  return registry.invokeTool<{ stopped: string[]; aborted?: true }>(
    "stop-all-simulator-servers",
    { devices },
    signal ? { signal } : undefined
  );
}

function read(deviceId: string, port?: number) {
  return registry.invokeTool<string>("view-network-logs", {
    device_id: deviceId,
    ...(port !== undefined ? { port } : {}),
  });
}

function details(deviceId: string, requestId: string) {
  return registry.invokeTool<unknown>("view-network-request-details", {
    device_id: deviceId,
    requestId,
  });
}

function layer<L extends { layer: string }>(result: CaptureResult<L>, name: string): L {
  const found = result.layers.find((l) => l.layer === name);
  if (!found) throw new Error(`no ${name} layer in ${JSON.stringify(result)}`);
  return found;
}

const urns = (): string[] => [...registry.getSnapshot().services.keys()];

const nativeUrns = (): string[] =>
  urns().filter((urn) => /^(NativeDevtools|AndroidNetworkInspector):/.test(urn));

/** Lets every pending callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const PLATFORMS = [
  {
    platform: "iOS",
    udid: IOS_UDID,
    native: "ios-native",
    connect: () => ios.connected.add(APP),
    nativeRecord: () => ios.record(APP),
    nativeMark: () => ios.networkCaptureMark(APP),
    nativeCalls: () => ios.calls,
  },
  {
    platform: "Android",
    udid: SERIAL,
    native: "android-native",
    connect: () => {},
    nativeRecord: () => androidFor(APP).record(),
    nativeMark: () => androidFor(APP).captureMark(),
    nativeCalls: () => androidFor(APP).calls,
  },
] as const;

describe("network-capture-start", () => {
  it("starts the JS and iOS native layers and says each is armed", async () => {
    serve(PORT, IOS_UDID, new FakeRuntime(APP));
    ios.connected.add(APP);

    const result = await start(IOS_UDID, APP);

    expect(result).toEqual({
      status: "ok",
      layers: [
        { layer: "js", armed: true },
        { layer: "ios-native", armed: true },
      ],
    });
    expect(ios.calls).toEqual([`start ${APP} ${PORT} 0`]);
  });

  it("starts the JS and Android native layers and passes on why the native one is not armed", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    const notRunning = `${APP} was not running at network-capture-start; launch-app or restart-app attaches the agent to its next process, or call network-capture-start once it runs`;
    androidFor(APP).startAnswer = () => ({ armed: false, reason: notRunning });

    const result = await start(SERIAL, APP);

    expect(result).toEqual({
      status: "ok",
      layers: [
        { layer: "js", armed: true },
        { layer: "android-native", armed: false, reason: notRunning },
      ],
    });
    expect(androidFor(APP).calls).toEqual([`start ${PORT}`]);
  });

  it("reports an Android app that cannot be attached unavailable, beside the JS layer that still records", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    androidFor(APP).startAnswer = () => ({
      armed: false,
      unavailable: true,
      reason: `${APP} is not debuggable`,
    });

    const result = await start(SERIAL, APP);

    expect(layer(result, "android-native")).toEqual({
      layer: "android-native",
      armed: false,
      unavailable: true,
      reason: `${APP} is not debuggable`,
    });
    expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
  });

  describe("when no layer can capture", () => {
    it("fails with NETWORK_CAPTURE_UNAVAILABLE and each layer's reason on iOS", async () => {
      const systemApp = "com.apple.mobilesafari";

      const err = await start(IOS_UDID, systemApp).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE,
        error_kind: "unsupported",
      });
      expect(err?.message).toContain(
        `Network capture cannot start for ${systemApp} on ${IOS_UDID}: js: ${systemApp} is an Apple system app, which runs no React Native JS; ios-native: ${systemApp} is an Apple system app, which native network capture never covers`
      );
      expect(nativeUrns()).toEqual([]);
    });

    it("fails with NETWORK_CAPTURE_UNAVAILABLE and each layer's reason on Android", async () => {
      androidFor(APP).startAnswer = () => ({
        armed: false,
        unavailable: true,
        reason: `${APP} is not debuggable`,
      });

      const err = await start(SERIAL, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(`js: ${METRO_DOWN}; android-native: ${APP} is not debuggable`);
      // view-network-logs only reads, so a start with no JS layer must not send the caller there.
      expect(err?.message).not.toContain("view-network-logs");
      // An unavailable start leaves no mark to count from.
      expect(androidFor(APP).captureMark()).toBeUndefined();
    });

    it("does not fail while a layer is only waiting for the app", async () => {
      ios.appState = "connecting";

      const result = await start(IOS_UDID, APP);

      expect(result).toEqual({
        status: "ok",
        layers: [
          { layer: "js", armed: false, unavailable: true, reason: METRO_DOWN },
          {
            layer: "ios-native",
            armed: false,
            reason: "the app has not connected yet; capture arms when it does",
          },
        ],
      });
      // An app that is still connecting gets 5 s to arm.
      expect(ios.calls).toEqual([`start ${APP} ${PORT} 5000`]);
    });
  });

  it.each(PLATFORMS)(
    "on $platform, a second start moves each mark, a stop keeps it, and a start after the stop moves it again",
    async ({ udid, connect, nativeRecord, nativeMark }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, udid, rt);
      connect();

      await start(udid, APP);
      // The context had no interceptor, so every record it gets came after this start.
      expect(findJsCapture(udid, APP)?.mark).toEqual({ install: null });
      const first = lastRecord;
      expect(nativeMark()).toEqual({ lastRecord: first, metroPort: PORT });

      rt.send("/a");
      rt.send("/b");
      nativeRecord();
      nativeRecord();
      await start(udid, APP);
      const second = findJsCapture(udid, APP)?.mark;
      expect(second).toEqual({ install: expect.any(String), lastId: 2 });
      expect(nativeMark()).toEqual({ lastRecord: first + 2, metroPort: PORT });

      rt.send("/c");
      nativeRecord();
      await stop(udid, APP);
      expect(findJsCapture(udid, APP)).toMatchObject({ intent: "stopped", mark: second });
      expect(nativeMark()).toEqual({ lastRecord: first + 2, metroPort: PORT });

      await start(udid, APP);
      expect(findJsCapture(udid, APP)).toMatchObject({
        intent: "started",
        mark: { install: (second as { install: string }).install, lastId: 3 },
      });
      expect(nativeMark()).toEqual({ lastRecord: first + 3, metroPort: PORT });
    }
  );

  describe("on the JS layer", () => {
    it("reads the mark before it installs the interceptor, so the requests of the install count", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);

      const result = await start(IOS_UDID, APP);

      expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
      expect(rt.evaluated.slice(0, 3)).toEqual(["mark", "resume", "install"]);
      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
        intent: "started",
        mark: { install: null },
        installed: true,
      });
    });

    it("is not armed, and not unavailable, before the app's JavaScript has loaded, and arms at the next start once it has", async () => {
      const rt = new FakeRuntime(APP, { loaded: false });
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);

      const before = await start(IOS_UDID, APP);

      expect(layer(before, "js")).toEqual({
        layer: "js",
        armed: false,
        reason:
          "the app's JavaScript has not loaded yet; call network-capture-start again once it has",
      });
      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
        intent: "started",
        mark: { install: null },
        installed: false,
      });

      rt.loadBundle();
      const after = await start(IOS_UDID, APP);

      expect(layer(after, "js")).toEqual({ layer: "js", armed: true });
      rt.send("/a");
      expect(await read(IOS_UDID)).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
    });

    it.each([
      {
        start2: "does not reach the runtime",
        prepare: async (rt: FakeRuntime) => {
          await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
          return rt;
        },
      },
      {
        start2: "fails to install",
        prepare: async (rt: FakeRuntime) => {
          const evaluate = rt.evaluate.bind(rt);
          rt.evaluate = (expr: string) => {
            if (scriptName(expr) === "install") throw new Error("Runtime.evaluate timed out");
            return evaluate(expr);
          };
          return rt;
        },
      },
    ])(
      "remembers the interceptor an earlier start installed when a second start $start2",
      async ({ prepare }) => {
        const rt = new FakeRuntime(APP);
        serve(PORT, IOS_UDID, rt);
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        await prepare(rt);

        const second = await start(IOS_UDID, APP);

        expect(layer(second, "js")).toMatchObject({ armed: false });
        expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ intent: "started", installed: true });

        // A stop that cannot reach the runtime must not take the interceptor for gone.
        await reconnect(PORT, IOS_UDID, undefined);
        expect(layer(await stop(IOS_UDID, APP), "js")).toEqual({
          layer: "js",
          armed: true,
          total: 0,
          reason: `${METRO_DOWN}; the interceptor already in the app's JS runtime may still record, so call network-capture-stop again once the app answers`,
        });
        expect(rt.paused).toBe(false);
      }
    );

    it("keeps a stop's pause when a later start does not reach the runtime", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      await stop(IOS_UDID, APP);
      expect(rt.paused).toBe(true);

      await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      await start(IOS_UDID, APP);

      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
        intent: "started",
        installed: true,
        paused: true,
      });
      // The paused interceptor records nothing, so a stop that cannot reach it is confirmed.
      await reconnect(PORT, IOS_UDID, undefined);
      expect(layer(await stop(IOS_UDID, APP), "js")).toMatchObject({ armed: false });
    });

    it("stores a started capture with an empty mark when Metro has no app connected yet", async () => {
      serve(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      ios.connected.add(APP);

      const result = await start(IOS_UDID, APP);

      expect(layer(result, "js")).toEqual({
        layer: "js",
        armed: false,
        reason: `no app is connected to Metro on port ${PORT} yet; call network-capture-start again once the app runs`,
      });
      expect(findJsCapture(IOS_UDID, APP)).toEqual({
        bundleId: APP,
        intent: "started",
        mark: { install: null },
        installed: false,
        port: PORT,
      });
    });

    const NOT_REACHED = [
      {
        found: "no Metro",
        answer: (): FakeRuntime | FailureCode | undefined => undefined,
        reason: METRO_DOWN,
      },
      {
        found: "a Metro with no runtime of this device",
        answer: (): FakeRuntime | FailureCode | undefined =>
          FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
        reason: `several devices are connected to Metro on port ${PORT}, so the JS layer cannot tell which runtime is this device's; give each device its own Metro port (udid takes the id from list-devices, not a logicalDeviceId)`,
      },
      {
        found: "another app's runtime",
        answer: (): FakeRuntime | FailureCode | undefined => new FakeRuntime(OTHER),
        reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; pass the port of ${APP}'s Metro`,
      },
    ];

    it.each(NOT_REACHED)(
      "is unavailable and keeps no mark when it finds $found, also after an earlier start there that installed nothing",
      async ({ answer, reason }) => {
        // The app's JavaScript has not loaded, so the earlier start installs nothing.
        serve(PORT, IOS_UDID, new FakeRuntime(APP, { loaded: false }));
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ installed: false });

        await reconnect(PORT, IOS_UDID, answer());
        const result = await start(IOS_UDID, APP);

        expect(layer(result, "js")).toEqual({
          layer: "js",
          armed: false,
          unavailable: true,
          reason,
        });
        expect(findJsCapture(IOS_UDID, APP)).toBeUndefined();
      }
    );

    it.each(NOT_REACHED)(
      "keeps the capture an earlier start installed when it finds $found, so a stop still says the interceptor may record",
      async ({ answer, reason }) => {
        const rt = new FakeRuntime(APP);
        serve(PORT, IOS_UDID, rt);
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        const capture = findJsCapture(IOS_UDID, APP);
        expect(capture).toMatchObject({ intent: "started", installed: true });

        await reconnect(PORT, IOS_UDID, answer());
        const result = await start(IOS_UDID, APP);

        expect(layer(result, "js")).toEqual({
          layer: "js",
          armed: false,
          unavailable: true,
          reason,
        });
        expect(findJsCapture(IOS_UDID, APP)).toEqual(capture);

        // The app's interceptor still records, so a stop that does not reach it is not confirmed.
        const stopped = await stop(IOS_UDID, APP);
        expect(layer(stopped, "js")).toMatchObject({
          armed: true,
          reason: expect.stringContaining("may still record"),
        });
        expect(rt.paused).toBe(false);

        // Once the app's runtime answers again, the next stop pauses it.
        await reconnect(PORT, IOS_UDID, rt);
        expect(layer(await stop(IOS_UDID, APP), "js")).toMatchObject({ armed: false });
        expect(rt.paused).toBe(true);
      }
    );
  });

  describe("on the iOS native layer", () => {
    beforeEach(() => {
      serve(PORT, IOS_UDID, new FakeRuntime(undefined));
    });

    it("reports an Apple system app unavailable and resolves no native service, on start and on stop", async () => {
      const systemApp = "com.apple.mobilesafari";
      const reason = `${systemApp} is an Apple system app, which native network capture never covers`;

      // Also with a Metro that has no app connected, which a JS layer of another app would wait for.
      serve(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      const err = await start(IOS_UDID, systemApp).then(
        () => undefined,
        (e: unknown) => e as Error
      );
      // The start stores no JS capture for an app that never runs JS.
      expect(findJsCapture(IOS_UDID, systemApp)).toBeUndefined();
      const stopped = await stop(IOS_UDID, systemApp);

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(
        `js: ${systemApp} is an Apple system app, which runs no React Native JS; ios-native: ${reason}`
      );
      expect(layer(stopped, "ios-native")).toEqual({
        layer: "ios-native",
        armed: false,
        total: 0,
        reason,
      });
      expect(nativeUrns()).toEqual([]);
      expect(ios.calls).toEqual([]);
    });

    it("waits for an app on a device provider's simulator to connect through the provider's agent", async () => {
      ios.armsEnv = false;
      ios.appState = "provider_attached";

      const result = await start(IOS_UDID, APP);

      expect(layer(result, "ios-native")).toEqual({
        layer: "ios-native",
        armed: false,
        reason:
          "the app has not connected through the device's devtools agent; it arms when it does",
      });
      expect(ios.calls).toEqual([`start ${APP} ${PORT} 0`]);
    });

    it("tells to restart an app whose running process cannot be armed", async () => {
      ios.appState = "stale_process";

      const result = await start(IOS_UDID, APP);

      expect(layer(result, "ios-native")).toEqual({
        layer: "ios-native",
        armed: false,
        reason:
          "no running process of the app can be armed; capture arms at its next launch, so call restart-app to capture it now",
      });
      // Capture is on, so the next launch arms it.
      expect(ios.isNetworkCaptureStarted(APP)).toBe(true);
    });

    it("reports a service the app no longer dials unavailable and starts nothing", async () => {
      ios.appState = "unregistered";

      const result = await start(IOS_UDID, APP);

      expect(layer(result, "ios-native")).toMatchObject({
        layer: "ios-native",
        armed: false,
        unavailable: true,
      });
      expect(ios.calls).toEqual([]);
      expect(ios.networkCaptureMark(APP)).toBeUndefined();
    });

    it.each([
      {
        note: "the app did not acknowledge Network.enable within 5 s; network-capture-start asks again",
        reason:
          "the app did not acknowledge Network.enable within 5 s; network-capture-start asks again",
      },
      { note: undefined, reason: "waiting for the agent to acknowledge Network.enable" },
    ])(
      "gives the app's own note when a connected app did not acknowledge ($reason)",
      async ({ note, reason }) => {
        ios.connected.add(APP);
        ios.acknowledges = false;
        ios.note = note;

        const result = await start(IOS_UDID, APP);

        expect(layer(result, "ios-native")).toEqual({ layer: "ios-native", armed: false, reason });
      }
    );

    it("fails with Xcode's refusal while its first launch is pending", async () => {
      ios.envError = new XcodeFirstLaunchPendingError("simctl");

      const err = await start(IOS_UDID, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(err?.cause).toBeInstanceOf(XcodeFirstLaunchPendingError);
      expect(ios.calls).toEqual([]);
    });
  });
});

describe("network-capture-stop", () => {
  it("returns what each layer keeps on iOS, once both confirmed the stop", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.send("/a");
    rt.send("/b");
    ios.record(APP);
    ios.record(APP);
    ios.record(APP);

    const result = await stop(IOS_UDID, APP);

    expect(result).toEqual({
      status: "ok",
      layers: [
        { layer: "js", armed: false, total: 2 },
        { layer: "ios-native", armed: false, total: 3 },
      ],
    });
    expect(rt.paused).toBe(true);
    expect(ios.calls).toEqual([`start ${APP} ${PORT} 0`, `stop ${APP}`]);
  });

  it("says an Android layer that did not confirm the stop is still armed", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    await start(SERIAL, APP);
    androidFor(APP).record();
    const reason =
      "the agent did not acknowledge Network.disable within 5 s; argent records none of the app's new requests, and launches do not attach it";
    androidFor(APP).stopAnswer = { confirmed: false, reason };

    const result = await stop(SERIAL, APP);

    expect(layer(result, "android-native")).toEqual({
      layer: "android-native",
      armed: true,
      total: 1,
      reason,
    });
  });

  it("keeps the JS layer stopped, and says the installed interceptor may still record, when the app's runtime cannot be reached", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    await start(SERIAL, APP);
    await reconnect(PORT, SERIAL, undefined);

    const result = await stop(SERIAL, APP);
    const unconfirmed = {
      layer: "js",
      armed: true,
      total: 0,
      reason: `${METRO_DOWN}; the interceptor already in the app's JS runtime may still record, so call network-capture-stop again once the app answers`,
    };

    expect(layer(result, "js")).toEqual(unconfirmed);
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", port: PORT });

    // The first stop did not reach the interceptor either, so a second one says the same.
    const second = await stop(SERIAL, APP);

    expect(layer(second, "js")).toEqual(unconfirmed);
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", port: PORT });
  });

  it("stores a stopped JS layer, with no interceptor to pause, after a start that installed none when the runtime cannot be reached", async () => {
    // The start found Metro with no app connected, so it installed nothing.
    serve(PORT, SERIAL, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
    await start(SERIAL, APP);
    serve(PORT, SERIAL, undefined);

    const result = await stop(SERIAL, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `${METRO_DOWN}; while capture is stopped, the app's JS runtime gets no interceptor`,
    });
    expect(findJsCapture(SERIAL, APP)).toMatchObject({
      intent: "stopped",
      port: PORT,
      installed: false,
    });
  });

  it("stores nothing, and says capture was not started, for an app with no capture when the runtime cannot be reached", async () => {
    const result = await stop(SERIAL, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `${METRO_DOWN}; ${NOT_STARTED}`,
    });
    expect(findJsCapture(SERIAL, APP)).toBeUndefined();
  });

  it("leaves another app's capture on the port as it is when it stops an app never started there and the runtime cannot be reached", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    await start(SERIAL, APP);
    const capture = structuredClone(findJsCapture(SERIAL, APP));
    expect(capture).toMatchObject({ intent: "started", port: PORT });
    await reconnect(PORT, SERIAL, undefined);

    const result = await stop(SERIAL, OTHER);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `${NOT_STARTED}; the capture of ${APP} on Metro port ${PORT} stays as it is`,
    });
    expect(findJsCapture(SERIAL, APP)).toEqual(capture);
    expect(findJsCapture(SERIAL, OTHER)).toBeUndefined();
  });

  it("neither pauses nor replaces another app's capture when it stops an app never started on a runtime that names no app", async () => {
    const rt = new FakeRuntime(undefined);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    const capture = structuredClone(findJsCapture(SERIAL, APP));

    const result = await stop(SERIAL, OTHER);
    rt.send("/after-the-other-stop");

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `${NOT_STARTED}; the capture of ${APP} on Metro port ${PORT} stays as it is`,
    });
    expect(findJsCapture(SERIAL, APP)).toEqual(capture);
    expect(rt.evaluated).not.toContain("pause");
    // The app's own stop still finds its capture, and counts the request.
    const own = await stop(SERIAL, APP);
    expect(layer(own, "js")).toMatchObject({ armed: false, total: 1 });
    expect(layer(own, "js")).not.toHaveProperty("reason");
  });

  it("does not say an interceptor may still record when a stop already paused it and the runtime is gone", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    await start(SERIAL, APP);
    expect(layer(await stop(SERIAL, APP), "js")).toMatchObject({ armed: false });
    await reconnect(PORT, SERIAL, undefined);

    const again = await stop(SERIAL, APP);

    expect(layer(again, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `${METRO_DOWN}; while capture is stopped, the app's JS runtime gets no interceptor`,
    });
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", paused: true });
  });

  it("refuses the JS layer of an Apple system app on stop as on start, and changes nothing there", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    await start(IOS_UDID, APP);
    const capture = structuredClone(findJsCapture(IOS_UDID, APP));

    const result = await stop(IOS_UDID, "com.apple.Preferences");

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: "com.apple.Preferences is an Apple system app, which runs no React Native JS",
    });
    expect(findJsCapture(IOS_UDID, APP)).toEqual(capture);
    expect(rt.evaluated).not.toContain("pause");
  });

  it("on iOS, leaves an app never started on the live native service as it is, and says capture was not started", async () => {
    // Another app's capture keeps the service live.
    ios.connected.add(OTHER);
    await start(IOS_UDID, OTHER);
    expect(nativeUrns()).toEqual([expect.stringMatching(/^NativeDevtools:/)]);

    const result = await stop(IOS_UDID, APP);

    expect(layer(result, "ios-native")).toEqual({
      layer: "ios-native",
      armed: false,
      total: 0,
      reason: NOT_STARTED,
    });
    // No stop reached the service, so the app is not stopped there and the other app stays on.
    expect(ios.calls).toEqual([`start ${OTHER} ${PORT} 0`]);
    expect(ios.isNetworkCaptureStopped(APP)).toBe(false);
    expect(ios.isNetworkCaptureStarted(OTHER)).toBe(true);
  });

  it("on Android, stops nothing after a start that found the app unavailable, and says capture was not started", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    androidFor(APP).startAnswer = () => ({
      armed: false,
      unavailable: true,
      reason: `${APP} is not debuggable`,
    });
    const started = await start(SERIAL, APP);
    expect(layer(started, "android-native")).toMatchObject({ armed: false, unavailable: true });
    expect(nativeUrns()).toEqual([expect.stringMatching(/^AndroidNetworkInspector:/)]);

    const result = await stop(SERIAL, APP);

    expect(layer(result, "android-native")).toEqual({
      layer: "android-native",
      armed: false,
      total: 0,
      reason: NOT_STARTED,
    });
    expect(androidFor(APP).calls).toEqual([`start ${PORT}`]);
  });

  it.each(PLATFORMS)(
    "on $platform, before any start, creates no native service and says capture was not started",
    async ({ udid, native }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, udid, rt);

      const result = await stop(udid, APP);

      expect(result).toEqual({
        status: "ok",
        layers: [
          { layer: "js", armed: false, total: 0, reason: NOT_STARTED },
          { layer: native, armed: false, total: 0, reason: NOT_STARTED },
        ],
      });
      expect(nativeUrns()).toEqual([]);
      expect(androidFactoryCalls).toBe(0);
      // The JS runtime is paused, not given an interceptor.
      expect(rt.evaluated).toEqual(["pause", "read"]);
      expect(findJsCapture(udid, APP)).toMatchObject({ intent: "stopped" });
    }
  );

  it.each(PLATFORMS)(
    "on $platform, a second stop changes nothing",
    async ({ udid, connect, nativeRecord, nativeCalls }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, udid, rt);
      connect();
      await start(udid, APP);
      rt.send("/a");
      nativeRecord();

      const first = await stop(udid, APP);
      const capture = jsCapture(jsCapturePayload(PORT, udid));
      const second = await stop(udid, APP);

      expect(second).toEqual(first);
      expect(first.layers.map((l) => [l.layer, l.armed, l.total, l.reason])).toEqual([
        ["js", false, 1, undefined],
        [first.layers[1]!.layer, false, 1, undefined],
      ]);
      expect(jsCapture(jsCapturePayload(PORT, udid))).toEqual(capture);
      expect(rt.paused).toBe(true);
      expect(nativeCalls().filter((call) => call.startsWith("stop"))).toHaveLength(2);
    }
  );
});

describe("stop-all-simulator-servers", () => {
  const OTHER_PORT = 8199;

  it("forgets the JS capture its pause reached when the call is aborted, and leaves the others as they are", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    // Another app's capture, whose Metro is down: the pause does not reach it.
    serve(OTHER_PORT, IOS_UDID, new FakeRuntime(OTHER));
    await start(IOS_UDID, OTHER, OTHER_PORT);
    await reconnect(OTHER_PORT, IOS_UDID, undefined);
    const otherCapture = structuredClone(jsCapture(jsCapturePayload(OTHER_PORT, IOS_UDID)));
    const controller = new AbortController();
    const evaluate = rt.evaluate.bind(rt);
    rt.evaluate = (expr: string) => {
      if (scriptName(expr) === "end") controller.abort();
      return evaluate(expr);
    };

    const result = await stopAll([IOS_UDID], controller.signal);

    expect(result).toEqual({ stopped: [], aborted: true });
    expect(rt.paused).toBe(true);
    expect(jsCapture(jsCapturePayload(PORT, IOS_UDID))).toBeUndefined();
    expect(jsCapture(jsCapturePayload(OTHER_PORT, IOS_UDID))).toEqual(otherCapture);
    expect(await read(IOS_UDID)).toBe(
      `Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then call view-network-logs again. This device has network capture for ${OTHER} on Metro port ${OTHER_PORT}: pass port ${OTHER_PORT} to read it.`
    );
  });

  it("removes the app's JS requests, so a list after the next start shows only the new ones", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.send("/before");
    expect(await read(IOS_UDID)).toContain("{id: rn-net-1}");

    await stopAll([IOS_UDID]);
    await start(IOS_UDID, APP);
    rt.send("/after");
    const text = await read(IOS_UDID);

    expect(text).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
    expect(text).toContain("{id: rn-net-2}");
    expect(text).not.toContain("rn-net-1");
    expect(await details(IOS_UDID, "rn-net-1")).toBe(
      "Request not found. Use view-network-logs to list available requests."
    );
    expect(await details(IOS_UDID, "rn-net-2")).toMatchObject({ requestId: "rn-net-2" });
  });

  it.each([
    {
      pause: "skips a debugger that is not live",
      /** Returns what makes the runtime answer again. */
      prepare: async (rt: FakeRuntime) => {
        // Another debugger took the app's page, and the app runs on.
        await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED);
        const urn = `JsRuntimeDebugger:${jsCapturePayload(PORT, IOS_UDID)}`;
        await registry.resolveService(urn).catch(() => {});
        expect(registry.getSnapshot().services.get(urn)?.state).toBe(ServiceState.ERROR);
        return () => serve(PORT, IOS_UDID, rt);
      },
    },
    {
      pause: "gets no answer in time",
      prepare: async (rt: FakeRuntime) => {
        const evaluate = rt.evaluate.bind(rt);
        rt.evaluate = (expr: string) => {
          if (scriptName(expr) === "end") throw new Error("CDP request timed out");
          return evaluate(expr);
        };
        return () => {
          rt.evaluate = evaluate;
        };
      },
    },
  ])(
    "keeps the JS capture stopped when its pause $pause, and a later network-capture-stop pauses the interceptor",
    async ({ prepare }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      rt.send("/a");
      const { mark } = findJsCapture(IOS_UDID, APP)!;
      const answer = await prepare(rt);

      await stopAll([IOS_UDID]);

      expect(jsCapture(jsCapturePayload(PORT, IOS_UDID))).toEqual({
        bundleId: APP,
        intent: "stopped",
        mark,
        installed: true,
      });
      expect(rt.paused).toBe(false);

      answer();
      expect(await read(IOS_UDID)).toContain("1 total; capture stopped");
      expect(layer(await stop(IOS_UDID, APP), "js")).toEqual({
        layer: "js",
        armed: false,
        total: 1,
      });
      expect(rt.paused).toBe(true);
    }
  );
});

describe("a JS runtime of another app on the port", () => {
  it("is left as it is by a start, with that app's stopped capture, which a read still reports", async () => {
    const rt = new FakeRuntime(OTHER);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await stop(IOS_UDID, OTHER);
    const payload = jsCapturePayload(PORT, IOS_UDID);
    const otherCapture = structuredClone(jsCapture(payload));
    const evaluated = rt.evaluated.length;

    const result = await start(IOS_UDID, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      unavailable: true,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; pass the port of ${APP}'s Metro`,
    });
    expect(jsCapture(payload)).toEqual(otherCapture);
    expect(rt.evaluated).toHaveLength(evaluated);

    const text = await read(IOS_UDID);

    // The read only reads: no interceptor, no NetworkInspector service.
    expect(rt.evaluated.slice(evaluated)).toEqual(["read"]);
    expect(urns()).not.toContain(`NetworkInspector:${payload}`);
    expect(text).toBe(
      `Network capture is stopped for ${OTHER} (network-capture-stop), and nothing was recorded in the app's current JS runtime. Call network-capture-start to capture again, then repeat the action.`
    );
  });

  it("stores the stop of this app's started capture there, and says its interceptor may still record", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    const otherRuntime = new FakeRuntime(OTHER);
    await reconnect(PORT, IOS_UDID, otherRuntime);

    const stopped = await stop(IOS_UDID, APP);

    expect(layer(stopped, "js")).toEqual({
      layer: "js",
      armed: true,
      total: 0,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; the interceptor already in ${APP}'s JS runtime may still record, so call network-capture-stop again once that runtime answers on this port`,
    });
    expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
      port: PORT,
      intent: "stopped",
      installed: true,
    });
    expect(otherRuntime.evaluated).toEqual([]);
    expect(rt.paused).toBe(false);

    // Once the app's runtime answers there again, the next stop pauses it.
    await reconnect(PORT, IOS_UDID, rt);
    rt.send("/a");
    expect(layer(await stop(IOS_UDID, APP), "js")).toEqual({ layer: "js", armed: false, total: 1 });
    expect(rt.paused).toBe(true);
  });

  it("gets nothing from a stop and a start of this app, and a read then says capture is not started", async () => {
    const rt = new FakeRuntime(OTHER);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);

    const stopped = await stop(IOS_UDID, APP);
    const started = await start(IOS_UDID, APP);
    const text = await read(IOS_UDID);

    expect(layer(stopped, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s, so nothing changed there; pass the port of ${APP}'s Metro`,
    });
    expect(layer(started, "js")).toMatchObject({ armed: false, unavailable: true });
    expect(jsCapturesOn(IOS_UDID)).toEqual([]);
    expect(rt.evaluated).toEqual([]);
    expect(urns()).not.toContain(`NetworkInspector:${jsCapturePayload(PORT, IOS_UDID)}`);
    expect(text).toBe(
      "Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then call view-network-logs again."
    );
  });
});

describe("a JS capture on another Metro port", () => {
  const NEW_PORT = 8199;
  const hint = `this device has network capture for ${APP} on Metro port ${NEW_PORT}: pass port ${NEW_PORT}`;

  /** Capture started on NEW_PORT, with one request recorded there. */
  async function startedOnNewPort(): Promise<FakeRuntime> {
    const rt = new FakeRuntime(APP);
    serve(NEW_PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP, NEW_PORT);
    rt.send("/a");
    return rt;
  }

  it("stays as it is through a start and a stop on a port whose Metro is down", async () => {
    const rt = await startedOnNewPort();
    const capture = findJsCapture(IOS_UDID, APP);
    expect(capture).toMatchObject({ port: NEW_PORT, intent: "started" });

    const started = await start(IOS_UDID, APP);
    const stopped = await stop(IOS_UDID, APP);

    expect(layer(started, "js")).toEqual({
      layer: "js",
      armed: false,
      unavailable: true,
      reason: `${METRO_DOWN}; ${hint}`,
    });
    // Capture is still on where it was, so the JS layer is not stopped.
    expect(layer(stopped, "js")).toEqual({
      layer: "js",
      armed: true,
      total: 0,
      reason: `${METRO_DOWN}; ${hint}`,
    });
    expect(jsCapturesOn(IOS_UDID)).toEqual([capture]);
    expect(rt.paused).toBe(false);
    expect(await read(IOS_UDID, NEW_PORT)).toContain(
      "=== NETWORK LOGS (page 1/1, 1 total) ===\n\n{id: "
    );

    const stoppedThere = await stop(IOS_UDID, APP, NEW_PORT);

    expect(layer(stoppedThere, "js")).toEqual({ layer: "js", armed: false, total: 1 });
    expect(rt.paused).toBe(true);
    expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ port: NEW_PORT, intent: "stopped" });
    // Once stopped there, a stop on the other port says the layer is not armed.
    expect(layer(await stop(IOS_UDID, APP), "js")).toMatchObject({
      armed: false,
      reason: `${METRO_DOWN}; ${hint}`,
    });
  });

  it("stays as it is through a start on a port whose Metro has no app connected yet", async () => {
    await startedOnNewPort();
    const capture = findJsCapture(IOS_UDID, APP);
    serve(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);

    const result = await start(IOS_UDID, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      reason: `no app is connected to Metro on port ${PORT} yet; ${hint}`,
    });
    expect(jsCapturesOn(IOS_UDID)).toEqual([capture]);
  });

  it("stays as it is through a start and a stop against another app's runtime, which name its port", async () => {
    await startedOnNewPort();
    const capture = findJsCapture(IOS_UDID, APP);
    const otherRuntime = new FakeRuntime(OTHER);
    serve(PORT, IOS_UDID, otherRuntime);

    const started = await start(IOS_UDID, APP);
    const stopped = await stop(IOS_UDID, APP);

    expect(layer(started, "js")).toEqual({
      layer: "js",
      armed: false,
      unavailable: true,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; ${hint}`,
    });
    // Capture is still on where it was, so the JS layer is not stopped.
    expect(layer(stopped, "js")).toEqual({
      layer: "js",
      armed: true,
      total: 0,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s, so nothing changed there; ${hint}`,
    });
    expect(jsCapturesOn(IOS_UDID)).toEqual([capture]);
    expect(otherRuntime.evaluated).toEqual([]);
  });

  it("stays as it is, with another app's capture on the port, through a stop there on runtimes that name no app", async () => {
    const rt = new FakeRuntime(undefined);
    serve(NEW_PORT, IOS_UDID, rt);
    await start(IOS_UDID, APP, NEW_PORT);
    const otherRuntime = new FakeRuntime(undefined);
    serve(PORT, IOS_UDID, otherRuntime);
    await start(IOS_UDID, OTHER);
    const captures = structuredClone(jsCapturesOn(IOS_UDID));
    expect(captures).toEqual([
      expect.objectContaining({ bundleId: APP, port: NEW_PORT, intent: "started" }),
      expect.objectContaining({ bundleId: OTHER, port: PORT, intent: "started" }),
    ]);
    const evaluated = otherRuntime.evaluated.length;

    const stopped = await stop(IOS_UDID, APP);

    // Capture is still on where it was, so the JS layer is not stopped.
    expect(layer(stopped, "js")).toEqual({
      layer: "js",
      armed: true,
      total: 0,
      reason: `the capture of ${OTHER} on Metro port ${PORT} stays as it is; ${hint}`,
    });
    expect(jsCapturesOn(IOS_UDID)).toEqual(captures);
    expect(otherRuntime.evaluated).toHaveLength(evaluated);
    expect(otherRuntime.paused).toBe(false);
    expect(rt.paused).toBe(false);
  });

  it("moves to a new port once the app's own runtime answers there", async () => {
    await startedOnNewPort();
    serve(PORT, IOS_UDID, new FakeRuntime(APP));

    const result = await start(IOS_UDID, APP);

    expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
    expect(jsCapturesOn(IOS_UDID)).toEqual([
      expect.objectContaining({ bundleId: APP, port: PORT, intent: "started" }),
    ]);
  });
});

describe("a start and a stop of one app", () => {
  /** Holds the app's Android start in its attach until `release` is called. */
  function holdStart(packageName: string): { release: () => void } {
    let release!: () => void;
    androidFor(packageName).startAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ armed: true });
      });
    return { release: () => release() };
  }

  it("run one after the other", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    const held = holdStart(APP);

    const starting = start(SERIAL, APP);
    await vi.waitFor(() => expect(androidFor(APP).calls).toEqual([`start ${PORT}`]));
    const stopping = stop(SERIAL, APP);
    await settle();

    expect(androidFor(APP).calls).toEqual([`start ${PORT}`]);
    expect(rt.evaluated).not.toContain("pause");

    held.release();
    await starting;
    await stopping;

    expect(androidFor(APP).calls).toEqual([`start ${PORT}`, "stop"]);
    expect(rt.paused).toBe(true);
  });

  it("do not hold up a start of another app on the device", async () => {
    serve(PORT, SERIAL, new FakeRuntime(APP));
    const held = holdStart(APP);

    const starting = start(SERIAL, APP);
    await vi.waitFor(() => expect(androidFor(APP).calls).toEqual([`start ${PORT}`]));

    const other = await start(SERIAL, OTHER);

    expect(layer(other, "android-native")).toEqual({ layer: "android-native", armed: true });
    held.release();
    await expect(starting).resolves.toMatchObject({ status: "ok" });
  });
});

describe("the tool definitions", () => {
  const tools = [
    { make: createNetworkCaptureStartTool, verb: ["Starting", "Started", "start"] },
    { make: createNetworkCaptureStopTool, verb: ["Stopping", "Stopped", "stop"] },
  ] as const;

  it.each(tools)("$verb.2 names the app in its 3 interaction messages", ({ make, verb }) => {
    const tool = make(new Registry());
    const params = { udid: IOS_UDID, bundleId: APP };
    const failureSignal = {
      error_code: FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE,
      failure_stage: "network_capture_start",
      failure_area: "tool_server",
      error_kind: "unsupported",
    } as const;

    expect(tool.interaction?.startedMsg?.({ params })).toBe(
      `${verb[0]} network capture for ${APP}`
    );
    expect(tool.interaction?.completedMsg?.({ params, result: { status: "ok", layers: [] } })).toBe(
      `${verb[1]} network capture for ${APP}`
    );
    expect(tool.interaction?.failedMsg?.({ params, error: new Error("x"), failureSignal })).toBe(
      `Failed to ${verb[2]} network capture for ${APP}: ${FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE}`
    );
  });

  it.each(tools)(
    "network-capture-$verb.2 runs on iOS simulators, remote simulators and Android, and refuses the rest",
    ({ make }) => {
      const tool = make(new Registry());

      expect(tool.capability).toEqual({
        apple: { simulator: true },
        appleRemote: { simulator: true },
        android: { emulator: true, device: true },
      });
      for (const id of [IOS_UDID, `remote:${IOS_UDID}`, SERIAL, "R5CT1234567"]) {
        expect(() => assertSupported(tool.id, tool.capability, resolveDevice(id))).not.toThrow();
      }
      for (const id of ["chromium-cdp-9222", "amazon-0123456789", "00008110-001A2B3C4D5E801E"]) {
        expect(() => assertSupported(tool.id, tool.capability, resolveDevice(id))).toThrow(
          UnsupportedOperationError
        );
      }
    }
  );
});
