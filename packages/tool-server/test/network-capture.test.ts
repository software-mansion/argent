import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { hostname } from "node:os";
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
  pauseJsCapturesOf,
} from "../src/blueprints/network-inspector";
import type {
  NativeDevtoolsApi,
  NativeDevtoolsAppState,
  NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  type AndroidCaptureStart,
  type AndroidNetworkInspectorApi,
} from "../src/blueprints/android-network-inspector";
import type { IosNetworkRecords } from "../src/blueprints/ios-network-records";
import type { NativeNetworkRecord } from "../src/utils/native-network-record";
import { createNetworkCaptureStartTool } from "../src/tools/network/network-capture-start";
import { createNetworkCaptureStopTool } from "../src/tools/network/network-capture-stop";
import {
  forgetIosUnavailableOf,
  type CaptureResult,
  type StartedLayer,
  type StoppedLayer,
} from "../src/tools/network/network-capture";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { createStopAllSimulatorServersTool } from "../src/tools/simulator/stop-all-simulator-servers";
import {
  NETWORK_CAPTURE_END_SCRIPT,
  NETWORK_CAPTURE_MARK_SCRIPT,
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkCaptureControlScript,
  makeNetworkLogReadScript,
} from "../src/utils/debugger/scripts/network-interceptor";
import {
  DependencyMissingError,
  XcodeFirstLaunchPendingError,
} from "../src/utils/dependency-errors";
import { BUNDLE_ID_MESSAGE } from "../src/utils/bundle-id";
import { forgetDeviceAlias, rememberDeviceAlias } from "../src/utils/debugger/device-alias";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { readAppProcesses } from "../src/blueprints/android-network-inspector-device";
import { localIosHost, remoteIosHost } from "../src/utils/ios-host";
import { proxyStart } from "../src/utils/sim-remote";

// The device's process table, which a stop reads when it cannot reach the app's JS runtime.
vi.mock("../src/blueprints/android-network-inspector-device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/blueprints/android-network-inspector-device")>()),
  readAppProcesses: vi.fn(),
}));
vi.mock("../src/utils/ios-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-host")>();
  return {
    ...actual,
    localIosHost: { ...actual.localIosHost, listRunningBundleIds: vi.fn() },
    remoteIosHost: { ...actual.remoteIosHost, listRunningBundleIds: vi.fn() },
  };
});

// A lookup of adb that a test holds open, or that finds no adb; otherwise the real one.
const adbLookup = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  reached: false,
  missing: false,
}));
vi.mock("../src/utils/android-binary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-binary")>();
  return {
    ...actual,
    resolveAndroidBinary: async (name: "adb" | "emulator") => {
      if (adbLookup.missing) return null;
      if (!adbLookup.hold) return actual.resolveAndroidBinary(name);
      adbLookup.reached = true;
      await adbLookup.hold;
      return `/fake/${name}`;
    },
  };
});

// The commands a test removes from PATH; the others resolve as on this host.
const notOnPath = vi.hoisted(() => new Set<string>());
vi.mock("../src/utils/command-on-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/command-on-path")>();
  return {
    ...actual,
    commandOnPath: async (name: string) =>
      notOnPath.has(name) ? null : actual.commandOnPath(name),
  };
});

// The sim-remote tunnel from a remote simulator to this host's Metro.
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  proxyStart: vi.fn(async () => {}),
}));

// Whether Xcode's component install is pending. The suite-wide setup answers no.
const xcode = vi.hoisted(() => ({ pending: false }));
vi.mock("../src/utils/xcode-first-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/xcode-first-launch")>()),
  xcodeFirstLaunchPending: () => xcode.pending,
}));

const IOS_UDID = "11111111-2222-3333-4444-555555555555";
const REMOTE_UDID = "remote:66666666-7777-8888-9999-000000000000";
const SERIAL = "emulator-5554";
/** An Android device on adb over Wi-Fi. */
const WIFI_SERIAL = "192.168.1.5:5555";
/** The id a Metro gives the device at SERIAL. */
const LOGICAL_ID = "b1946ac92492d2347c6235b4d2611184";
/** The id a device provider gives the device at SERIAL. */
const EXT_ID = `ext:acme-3f2a9c:${SERIAL}`;
const APP = "com.example.shop";
const OTHER = "com.example.other";
const PORT = 8081;
const NOT_STARTED = "capture was not started for this app";
const METRO_DOWN = `Metro is not running on port ${PORT}; start it, or pass the port of the app's Metro`;
const RESTART_REASON =
  "no running process of the app can be armed; capture arms at its next launch, so call restart-app to capture it now, then network-capture-start again, since a relaunch ends the JS layer's capture; if restart-app fails rather than starting the app, the bundle id is not installed on this simulator: check it, or install the app";

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

/** How long CDPClient waits for the answer to an evaluate that gives no timeout. */
const CDP_TIMEOUT_MS = 10_000;

/** An app's JS runtime behind Metro. argent's scripts run in a real JS context of it. */
class FakeRuntime {
  private readonly context: Context = createContext({});
  /** The scripts argent evaluated in it, in order. */
  readonly evaluated: ScriptName[] = [];
  /** The runtime keeps the connection but answers no evaluate, as a busy or frozen one. */
  frozen = false;

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

  evaluate(expr: string, timeout = CDP_TIMEOUT_MS): unknown {
    this.evaluated.push(scriptName(expr));
    if (this.frozen) {
      // CDPClient rejects a request that gets no answer within its timeout.
      return new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Runtime.evaluate timed out after ${timeout} ms`)),
          timeout
        )
      );
    }
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

/** The devices on a Metro that several devices share, as selectTarget lists them. */
const SHARED_ID = "8f2c1d7e-logical";
const SHARED_DEVICES = `iPhone 17 (${SHARED_ID}), Pixel 9 (5b0a-logical)`;

/** How long a debugger connect takes, as on a busy runtime. */
let connectDelayMs = 0;

/** The JS runtime debugger, reaching whatever {@link metro} serves for its payload. */
const fakeDebuggerBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "JsRuntimeDebugger",
  getURN: (payload) => `JsRuntimeDebugger:${payload}`,
  async factory(_deps, payload) {
    if (connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
    const port = Number(payload.slice(0, payload.indexOf(":")));
    const answer = metro.get(payload);
    if (answer === undefined) {
      throw notReached(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING, `nothing answers on port ${port}`);
    }
    if (answer === FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH) {
      // As selectTarget words it.
      throw notReached(
        answer,
        `No debugger target matches device_id "${payload.slice(payload.indexOf(":") + 1)}". 2 devices are connected to Metro on port ${port}: ${SHARED_DEVICES}. Re-target with the logicalDeviceId in parentheses.`
      );
    }
    if (typeof answer === "string") throw notReached(answer, `Metro on port ${port}: ${answer}`);
    const cdp = {
      evaluate: async (expr: string, options?: { timeout?: number }) =>
        answer.evaluate(expr, options?.timeout),
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
  /** What the service recorded when its env setup failed. */
  initFailure: NativeDevtoolsInitFailure | null = null;
  /** What the service factory throws, as the real one does when it cannot attach. */
  factoryError: Error | undefined;
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
    return this.initFailure;
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
  /** What the service factory throws for this package, as the real one does for a name it refuses. */
  factoryError: Error | undefined;
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
    if (ios.factoryError) throw ios.factoryError;
    return { api: ios, dispose: async () => {}, events: new TypedEventEmitter<ServiceEvents>() };
  },
};

const fakeAndroidInspectorBlueprint: ServiceBlueprint<unknown, string> = {
  namespace: "AndroidNetworkInspector",
  getURN: (payload) => `AndroidNetworkInspector:${payload}`,
  async factory(_deps, _payload, options) {
    androidFactoryCalls++;
    const { packageName } = options as { packageName: string };
    const fake = androidFor(packageName);
    if (fake.factoryError) throw fake.factoryError;
    return {
      api: fake,
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};

// ── The tools ───────────────────────────────────────────────────────────────

let registry: Registry;

/** The apps with a process on the device, or undefined while the device does not answer. */
let running: Set<string> | undefined;

beforeEach(() => {
  running = new Set([APP, OTHER]);
  vi.mocked(readAppProcesses).mockImplementation(async (_serial, packageName) => {
    if (!running) throw new Error("adb: device offline");
    return {
      user: 0,
      processes: running.has(packageName) ? [{ pid: 4242, startTime: 1, user: 0 }] : [],
    };
  });
  vi.mocked(localIosHost.listRunningBundleIds).mockImplementation(async () => {
    if (!running) throw new Error("simctl spawn timed out");
    return new Set(running);
  });
  vi.mocked(remoteIosHost.listRunningBundleIds).mockImplementation(async () => {
    if (!running) throw new Error("sim-remote spawn timed out");
    return new Set(running);
  });
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
  connectDelayMs = 0;
  forgetJsCapturesOf();
  forgetIosUnavailableOf();
  ios = new FakeIos();
  android.clear();
  androidFactoryCalls = 0;
  xcode.pending = false;
  adbLookup.hold = undefined;
  adbLookup.reached = false;
  adbLookup.missing = false;
  notOnPath.clear();
  __primeDepCacheForTests(["xcrun", "adb", "sim-remote"]);
});

afterEach(async () => {
  await registry.dispose();
  forgetJsCapturesOf();
  __resetDepCacheForTests();
});

function start(udid: string, bundleId: string, port?: number, logicalDeviceId?: string) {
  return registry.invokeTool<CaptureResult<StartedLayer>>("network-capture-start", {
    udid,
    bundleId,
    ...(port !== undefined ? { port } : {}),
    ...(logicalDeviceId !== undefined ? { logicalDeviceId } : {}),
  });
}

function stop(udid: string, bundleId: string, port?: number, logicalDeviceId?: string) {
  return registry.invokeTool<CaptureResult<StoppedLayer>>("network-capture-stop", {
    udid,
    bundleId,
    ...(port !== undefined ? { port } : {}),
    ...(logicalDeviceId !== undefined ? { logicalDeviceId } : {}),
  });
}

/** Without `devices`, the machine-wide sweep. */
function stopAll(devices: string[] | undefined, signal?: AbortSignal) {
  return registry.invokeTool<{ stopped: string[]; aborted?: true }>(
    "stop-all-simulator-servers",
    devices === undefined ? {} : { devices },
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

/** The platforms on which a stop reads the device's processes. */
const PROCESS_PLATFORMS = [
  ...PLATFORMS,
  { platform: "a remote iOS simulator", udid: REMOTE_UDID },
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

  it("arms the JS layer without adb and reports the Android native layer unavailable with the install hint", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    adbLookup.missing = true;
    __resetDepCacheForTests();

    const result = await start(SERIAL, APP);

    expect(result).toEqual({
      status: "ok",
      layers: [
        { layer: "js", armed: true },
        {
          layer: "android-native",
          armed: false,
          unavailable: true,
          reason: expect.stringContaining("Android SDK Platform Tools not found"),
        },
      ],
    });
    expect(rt.evaluated).toContain("install");
    expect(androidFactoryCalls).toBe(0);
  });

  it("arms the JS layer without xcrun and reports the iOS native layer unavailable with the install hint", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    notOnPath.add("xcrun");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["adb", "sim-remote"]);

    const result = await start(IOS_UDID, APP);

    expect(result).toEqual({
      status: "ok",
      layers: [
        { layer: "js", armed: true },
        {
          layer: "ios-native",
          armed: false,
          unavailable: true,
          reason: expect.stringContaining("Xcode command-line tools not found"),
        },
      ],
    });
    expect(rt.evaluated).toContain("install");
    expect(ios.calls).toEqual([]);
  });

  it("fails without sim-remote on a remote iOS simulator before it reaches either layer", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, REMOTE_UDID, rt);
    notOnPath.add("sim-remote");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["adb", "xcrun"]);

    const err = await start(REMOTE_UDID, APP).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    // The JS layer reaches a remote simulator's Metro over the sim-remote tunnel too.
    expect(err?.cause).toBeInstanceOf(DependencyMissingError);
    expect((err?.cause as DependencyMissingError).missing).toEqual(["sim-remote"]);
    expect(rt.evaluated).toEqual([]);
    expect(ios.calls).toEqual([]);
  });

  describe("when no layer can capture", () => {
    it("fails with TOOL_DEPENDENCY_MISSING and each layer's reason when adb is missing", async () => {
      adbLookup.missing = true;
      __resetDepCacheForTests();

      const err = await start(SERIAL, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(err?.cause).toBeInstanceOf(DependencyMissingError);
      expect((err?.cause as DependencyMissingError).missing).toEqual(["adb"]);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_DEPENDENCY_MISSING);
      expect(err?.message).toContain(
        `Network capture cannot start for ${APP} on ${SERIAL}: js: ${METRO_DOWN}; android-native: Android SDK Platform Tools not found`
      );
      expect(androidFactoryCalls).toBe(0);
    });

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

    it("fails with NETWORK_CAPTURE_UNAVAILABLE on Android when the inspector service refuses the package", async () => {
      const refusal =
        "AndroidNetworkInspector.factory needs { device, packageName } with an Android package name; use androidNetworkInspectorRef(device, packageName, metroPort).";
      androidFor(APP).factoryError = new Error(refusal);

      const err = await start(SERIAL, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(
        `js: ${METRO_DOWN}; android-native: [AndroidNetworkInspector:${SERIAL}:${APP}] ${refusal}`
      );
      expect(androidFor(APP).calls).toEqual([]);
    });

    it.each([
      {
        refusal: "does not grant the JS debugger",
        code: FAILURE_CODES.EXTERNAL_DEVICE_CAPABILITY_DENIED,
      },
      { refusal: "no longer offers the device", code: FAILURE_CODES.EXTERNAL_DEVICE_UNAVAILABLE },
    ])(
      "fails with NETWORK_CAPTURE_UNAVAILABLE when the device provider $refusal and the native layer is unavailable",
      async ({ code }) => {
        serve(PORT, IOS_UDID, code);
        ios.appState = "unregistered";

        const err = await start(IOS_UDID, APP).then(
          () => undefined,
          (e: unknown) => e as Error
        );

        expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
        expect(err?.message).toContain(
          `js: the JS debugger could not connect: [JsRuntimeDebugger:${PORT}:${IOS_UDID}] Metro on port ${PORT}: ${code}; ios-native: `
        );
        expect(err?.message).not.toContain("call network-capture-start again");
        expect(findJsCapture(IOS_UDID, APP)).toBeUndefined();
      }
    );

    it("does not fail while the interceptor an earlier start installed may still record", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, SERIAL, rt);
      const noOkHttp = {
        armed: false,
        unavailable: true as const,
        reason: "the app has no OkHttp",
      };
      androidFor(APP).startAnswer = () => noOkHttp;
      expect(layer(await start(SERIAL, APP), "js")).toEqual({ layer: "js", armed: true });
      await reconnect(PORT, SERIAL, undefined);

      const result = await start(SERIAL, APP);

      expect(result).toEqual({
        status: "ok",
        layers: [
          {
            layer: "js",
            armed: false,
            reason: `${METRO_DOWN}; the interceptor already in the app's JS runtime may still record, so call network-capture-start again once the app answers`,
          },
          { layer: "android-native", ...noOkHttp },
        ],
      });
      expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "started", installed: true });
      expect(rt.paused).toBe(false);
    });

    it("fails with NETWORK_CAPTURE_UNAVAILABLE on iOS when the native devtools service cannot start", async () => {
      const refusal =
        "NativeDevtools could not attach to the socket its provider published at /tmp/provider.sock: ECONNREFUSED.";
      ios.factoryError = new Error(refusal);

      const err = await start(IOS_UDID, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(
        `js: ${METRO_DOWN}; ios-native: [NativeDevtools:${IOS_UDID}] ${refusal}`
      );
      expect(ios.calls).toEqual([]);
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

    it("does not take an earlier start that installed nothing for an installed interceptor when a later start does not reach the runtime, so a stop says nothing records", async () => {
      serve(PORT, IOS_UDID, new FakeRuntime(APP, { loaded: false }));
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ installed: false });

      await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      await start(IOS_UDID, APP);

      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ intent: "started", installed: false });
      expect(layer(await stop(IOS_UDID, APP), "js")).toEqual({
        layer: "js",
        armed: false,
        total: 0,
        reason: `no app is connected to Metro on port ${PORT} yet; while capture is stopped, the app's JS runtime gets no interceptor`,
      });
    });

    it("lets view-network-request-details say that capture stopped recording at a reload, in the runtime the reload left without the interceptor", async () => {
      serve(PORT, IOS_UDID, new FakeRuntime(APP));
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      await reconnect(PORT, IOS_UDID, new FakeRuntime(APP));

      const text = await registry.invokeTool<string>("view-network-request-details", {
        device_id: IOS_UDID,
        requestId: "rn-net-1",
      });

      expect(text).toBe(
        "Request rn-net-1 not found. The JS layer of network capture for this app stopped recording at a JavaScript reload, so it recorded no requests since the reload. native-network-logs lists the requests of the native layer. To record the app's JavaScript requests again, call network-capture-start, repeat the action, then read again."
      );
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

    it("is not armed within 5 s on a runtime that does not answer, and keeps the interceptor and the pause of an earlier start and stop", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      await stop(IOS_UDID, APP);
      // A new CDP session, to a runtime that is busy or frozen.
      await reconnect(PORT, IOS_UDID, rt);
      rt.frozen = true;
      const before = rt.evaluated.length;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = start(IOS_UDID, APP);
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await vi.advanceTimersByTimeAsync(5_000);

        expect(settled).toBe(true);
        expect(layer(await pending, "js")).toEqual({
          layer: "js",
          armed: false,
          reason:
            "the app's JS runtime did not answer (Runtime.evaluate timed out after 5000 ms); call network-capture-start again once it answers",
        });
      } finally {
        // An evaluate that still waits gives up, so the capture lock frees.
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
      // Only the mark read reached the runtime: no install waited for it.
      expect(rt.evaluated.slice(before)).toEqual(["mark"]);
      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
        intent: "started",
        installed: true,
        paused: true,
      });
    });

    it.each([
      {
        logged: "nothing",
        before: 0,
        says: "No network traffic captured. The app's JS runtime does not record new requests: an earlier stop paused it (network-capture-stop, stop-all-simulator-servers or the exit of a tool-server), and no network-capture-start reached it since. Call network-capture-start, then repeat the action.",
      },
      {
        logged: "a request",
        before: 1,
        says: "=== NETWORK LOGS (page 1/1, 1 total; the app's JS runtime does not record new requests: an earlier stop paused it (network-capture-stop, stop-all-simulator-servers or the exit of a tool-server), and no network-capture-start reached it since, so call network-capture-start, then repeat the action) ===",
      },
    ])(
      "says a read of a started capture with $logged logged that the app's runtime does not record while a stop's pause stays there",
      async ({ before, says }) => {
        const rt = new FakeRuntime(APP);
        serve(PORT, IOS_UDID, rt);
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        if (before) rt.send("/before");
        await stop(IOS_UDID, APP);
        await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
        await start(IOS_UDID, APP);

        // The app connects again with the JS context that the stop paused.
        await reconnect(PORT, IOS_UDID, rt);
        rt.send("/dropped");
        const paused = await read(IOS_UDID);

        expect(paused.split("\n")[0]).toBe(says);
        expect(paused).not.toContain("/dropped");

        await start(IOS_UDID, APP);
        rt.send("/after");
        const listed = await read(IOS_UDID);

        expect(listed.split("\n")[0]).toBe(`=== NETWORK LOGS (page 1/1, ${before + 1} total) ===`);
        expect(listed).toContain('"GET /after"');
      }
    );

    it("says a read after a start that reached no app that only the JS layer recorded nothing, and names native-network-logs", async () => {
      serve(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      ios.connected.add(APP);
      const result = await start(IOS_UDID, APP);
      expect(layer(result, "js")).toMatchObject({ armed: false });
      expect(layer(result, "ios-native")).toEqual({ layer: "ios-native", armed: true });
      // The app connects to Metro and sends a request, which the native layer records.
      const rt = new FakeRuntime(APP);
      await reconnect(PORT, IOS_UDID, rt);
      rt.send("/api/checkout");
      ios.record(APP);
      const says =
        "Network capture for this app is started, but the app's JavaScript runtime was not ready at the start, so the JS layer recorded no requests. native-network-logs lists the requests of the native layer. To record the app's JavaScript requests, call network-capture-start again, repeat the action, then read again.";

      expect(await read(IOS_UDID)).toBe(says);
      expect(await details(IOS_UDID, "rn-net-1")).toBe(`Request rn-net-1 not found. ${says}`);
    });

    it.each(PLATFORMS)(
      "on $platform, lets a read after a start that found Metro down give that reason, until stop-all-simulator-servers or a start that reaches the app",
      async ({ udid, native, connect }) => {
        connect();
        const result = await start(udid, APP);
        expect(result.layers).toEqual([
          { layer: "js", armed: false, unavailable: true, reason: METRO_DOWN },
          { layer: native, armed: true },
        ]);
        const unavailable = `Network capture is not started on the JS layer: network-capture-start for ${APP} found it unavailable (${METRO_DOWN}). native-network-logs lists the requests of the native layer. Once the JS layer can start, call network-capture-start again, repeat the action, then`;

        expect(await read(udid)).toBe(`${unavailable} call view-network-logs again.`);
        expect(await details(udid, "rn-net-1")).toBe(
          `Request rn-net-1 not found. ${unavailable} list the requests with view-network-logs.`
        );

        await stopAll([udid]);
        expect(await read(udid)).toBe(
          "Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then call view-network-logs again."
        );

        await start(udid, APP);
        const rt = new FakeRuntime(APP);
        serve(PORT, udid, rt);
        await start(udid, APP);
        rt.send("/a");
        expect(await read(udid)).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
      }
    );

    it("does not name network-capture-stop as the cause of a pause that stop-all-simulator-servers left", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await start(IOS_UDID, APP);
      await stopAll([IOS_UDID]);
      ios.connected.add(APP);
      await reconnect(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      await start(IOS_UDID, APP);

      // The app connects again with the JS context that stop-all-simulator-servers paused.
      await reconnect(PORT, IOS_UDID, rt);
      rt.send("/dropped");

      expect(await read(IOS_UDID)).toBe(
        "No network traffic captured. The app's JS runtime does not record new requests: an earlier stop paused it (network-capture-stop, stop-all-simulator-servers or the exit of a tool-server), and no network-capture-start reached it since. Call network-capture-start, then repeat the action."
      );
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

    const SHARED_METRO = `several devices are connected to Metro on port ${PORT}, so the JS layer cannot tell which runtime is this device's; pass this device's logicalDeviceId (in parentheses: ${SHARED_DEVICES}), or give each device its own Metro port`;
    const STILL_RECORDS =
      "the interceptor already in the app's JS runtime may still record, so call network-capture-start again once the app answers";
    const NOT_REACHED = [
      {
        found: "no Metro",
        answer: (): FakeRuntime | FailureCode | undefined => undefined,
        reason: METRO_DOWN,
        kept: `${METRO_DOWN}; ${STILL_RECORDS}`,
      },
      {
        found: "a Metro with no runtime of this device",
        answer: (): FakeRuntime | FailureCode | undefined =>
          FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
        reason: SHARED_METRO,
        kept: `${SHARED_METRO}; ${STILL_RECORDS}`,
      },
      {
        found: "another app's runtime",
        answer: (): FakeRuntime | FailureCode | undefined => new FakeRuntime(OTHER),
        reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; if that runtime is the app, pass bundleId ${OTHER}; otherwise pass the port of ${APP}'s Metro`,
        kept: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; the interceptor already in ${APP}'s JS runtime may still record, so call network-capture-start again once that runtime answers on this port`,
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
      "is not unavailable, and keeps the capture an earlier start installed, when it finds $found, so a stop still says the interceptor may record",
      async ({ answer, kept }) => {
        const rt = new FakeRuntime(APP);
        serve(PORT, IOS_UDID, rt);
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        const capture = findJsCapture(IOS_UDID, APP);
        expect(capture).toMatchObject({ intent: "started", installed: true });

        await reconnect(PORT, IOS_UDID, answer());
        const result = await start(IOS_UDID, APP);

        expect(layer(result, "js")).toEqual({ layer: "js", armed: false, reason: kept });
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

    it.each(NOT_REACHED)(
      "keeps a stop and its requests when a later start finds $found, so the kept ids still resolve",
      async ({ answer, reason }) => {
        const rt = new FakeRuntime(APP);
        serve(PORT, IOS_UDID, rt);
        ios.connected.add(APP);
        await start(IOS_UDID, APP);
        rt.send("/a");
        await stop(IOS_UDID, APP);
        const capture = findJsCapture(IOS_UDID, APP);
        expect(capture).toMatchObject({ intent: "stopped", installed: true, paused: true });

        await reconnect(PORT, IOS_UDID, answer());
        const result = await start(IOS_UDID, APP);

        expect(layer(result, "js")).toEqual({
          layer: "js",
          armed: false,
          unavailable: true,
          reason,
        });
        expect(findJsCapture(IOS_UDID, APP)).toEqual(capture);

        // The app's runtime answers again, with the log the stop kept.
        await reconnect(PORT, IOS_UDID, rt);
        expect((await read(IOS_UDID)).split("\n")[0]).toBe(
          "=== NETWORK LOGS (page 1/1, 1 total; capture stopped) ==="
        );
        expect(await details(IOS_UDID, "rn-net-1")).toMatchObject({
          request: { url: "https://api.test/a" },
        });
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
      // The start waits up to 5 s for the provider's agent to connect and say whether capture is on.
      expect(ios.calls).toEqual([`start ${APP} ${PORT} 5000`]);
    });

    it("tells to restart an app whose running process cannot be armed, then to start again for the JS layer the relaunch ends", async () => {
      ios.appState = "stale_process";

      const result = await start(IOS_UDID, APP);

      expect(result.layers).toEqual([
        { layer: "js", armed: true },
        { layer: "ios-native", armed: false, reason: RESTART_REASON },
      ]);
      // Capture is on, so the next launch arms it.
      expect(ios.isNetworkCaptureStarted(APP)).toBe(true);

      // restart-app: a new process, with a new JS runtime that has no interceptor.
      const relaunched = new FakeRuntime(undefined);
      await reconnect(PORT, IOS_UDID, relaunched);
      ios.connected.add(APP);
      expect((await start(IOS_UDID, APP)).layers).toEqual([
        { layer: "js", armed: true },
        { layer: "ios-native", armed: true },
      ]);
      relaunched.send("/after-restart");
      expect(await read(IOS_UDID)).toContain('"GET /after-restart"');
    });

    it("says what a failed restart-app means for an app with no running process, which may not be installed", async () => {
      const typo = "com.example.shopp";
      ios.appState = "not_running";

      const result = await start(IOS_UDID, typo);

      expect(layer(result, "ios-native")).toEqual({
        layer: "ios-native",
        armed: false,
        reason: RESTART_REASON,
      });
      expect(RESTART_REASON).toContain(
        "if restart-app fails rather than starting the app, the bundle id is not installed on this simulator: check it, or install the app"
      );
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

    it("reports native devtools that failed to initialize unavailable, so a start with no other layer fails", async () => {
      serve(PORT, IOS_UDID, undefined);
      ios.envError = new Error("simctl spawn failed");
      ios.initFailure = { attempts: 1, lastError: "simctl spawn failed", givenUp: false };

      const err = await start(IOS_UDID, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(
        `ios-native: Native devtools failed to initialize for ${IOS_UDID} after 1 attempts. Last error: simctl spawn failed. Try shutting down and re-booting the simulator, or restart CoreSimulatorService.`
      );
      expect(ios.calls).toEqual([]);
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

    it("fails with Xcode's refusal only once the JS layer ends, and holds a stop of the app until then", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.envError = new XcodeFirstLaunchPendingError("simctl");
      // The JS layer is still at the read of the mark when the iOS layer throws.
      let releaseMark!: () => void;
      const markHeld = new Promise<void>((resolve) => (releaseMark = resolve));
      let markAsked = false;
      const evaluate = rt.evaluate.bind(rt);
      rt.evaluate = async (expr: string, timeout?: number) => {
        if (scriptName(expr) === "mark") {
          markAsked = true;
          await markHeld;
        }
        return evaluate(expr, timeout);
      };

      let failed = false;
      const starting = start(IOS_UDID, APP).then(
        () => undefined,
        (e: unknown) => {
          failed = true;
          return e as Error;
        }
      );
      await vi.waitFor(() => expect(markAsked).toBe(true));
      const stopping = stop(IOS_UDID, APP);
      await settle();

      expect(failed).toBe(false);
      expect(rt.evaluated).toEqual([]);

      releaseMark();
      const err = await starting;
      await stopping;

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      expect(rt.evaluated.indexOf("pause")).toBeGreaterThan(rt.evaluated.indexOf("install"));
    });

    it("fails while Xcode's first launch is pending before the JS layer reaches the app's runtime", async () => {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      xcode.pending = true;
      // The env setup of an app that is not connected runs simctl, which refuses now.
      ios.envError = new XcodeFirstLaunchPendingError("simctl");

      const err = await start(IOS_UDID, APP).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING);
      // A start that fails leaves nothing recording in the app.
      expect(rt.evaluated).toEqual([]);
      expect(findJsCapture(IOS_UDID, APP)).toBeUndefined();
      expect(ios.calls).toEqual([]);
    });

    it("refuses an Apple system app as unavailable while Xcode's first launch is pending, as no layer captures it", async () => {
      const systemApp = "com.apple.mobilesafari";
      xcode.pending = true;

      const err = await start(IOS_UDID, systemApp).then(
        () => undefined,
        (e: unknown) => e as Error
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE);
      expect(err?.message).toContain(
        `ios-native: ${systemApp} is an Apple system app, which native network capture never covers`
      );
      expect(nativeUrns()).toEqual([]);
    });

    it.each([
      { app: "a connected app", wait: 0, prepare: () => ios.connected.add(APP) },
      {
        app: "an app on a device provider's simulator",
        wait: 5000,
        prepare: () => {
          ios.armsEnv = false;
          ios.appState = "provider_attached";
        },
      },
    ])(
      "starts $app while Xcode's first launch is pending, as it needs no simctl",
      async ({ prepare, wait }) => {
        serve(PORT, IOS_UDID, new FakeRuntime(APP));
        xcode.pending = true;
        prepare();

        const result = await start(IOS_UDID, APP);

        expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
        expect(ios.calls).toEqual([`start ${APP} ${PORT} ${wait}`]);
      }
    );

    it("starts an app on a remote simulator while this Mac's Xcode first launch is pending, as it arms through sim-remote", async () => {
      serve(PORT, REMOTE_UDID, new FakeRuntime(APP));
      xcode.pending = true;

      const result = await start(REMOTE_UDID, APP);

      expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
      expect(ios.calls).toEqual([`start ${APP} ${PORT} 0`]);
    });

    it("starts the other layers while Xcode's first launch is pending when the native devtools service cannot start", async () => {
      serve(PORT, IOS_UDID, new FakeRuntime(APP));
      xcode.pending = true;
      const refusal =
        "NativeDevtools could not attach to the socket its provider published at /tmp/provider.sock: ECONNREFUSED.";
      ios.factoryError = new Error(refusal);

      const result = await start(IOS_UDID, APP);

      expect(result).toEqual({
        status: "ok",
        layers: [
          { layer: "js", armed: true },
          {
            layer: "ios-native",
            armed: false,
            unavailable: true,
            reason: `[NativeDevtools:${IOS_UDID}] ${refusal}`,
          },
        ],
      });
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

  it("says an iOS layer that did not confirm the stop is still armed", async () => {
    serve(PORT, IOS_UDID, new FakeRuntime(APP));
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    ios.record(APP);
    const reason =
      "the app did not acknowledge Network.disable within 5 s; argent records none of its new requests, and its next process starts without capture";
    ios.stopAnswer = { confirmed: false, reason };

    const result = await stop(IOS_UDID, APP);

    expect(layer(result, "ios-native")).toEqual({
      layer: "ios-native",
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

  it.each(PROCESS_PLATFORMS)(
    "on $platform, says nothing records, and stores no interceptor, when the app is not running and its runtime cannot be reached",
    async ({ udid }) => {
      serve(PORT, udid, new FakeRuntime(APP));
      await start(udid, APP);
      // The app was killed: Metro has no app connected, and the device has no process of it.
      await reconnect(PORT, udid, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      running = new Set([OTHER]);

      const result = await stop(udid, APP);

      expect(layer(result, "js")).toEqual({
        layer: "js",
        armed: false,
        total: 0,
        reason: `no app is connected to Metro on port ${PORT} yet; ${APP} is not running, so nothing records; while capture is stopped, its next JS runtime gets no interceptor`,
      });
      expect(findJsCapture(udid, APP)).toMatchObject({
        intent: "stopped",
        port: PORT,
        installed: false,
      });
      expect(findJsCapture(udid, APP)).not.toHaveProperty("paused");
    }
  );

  it.each([
    { platform: "a local iOS simulator", udid: IOS_UDID, own: localIosHost, other: remoteIosHost },
    {
      platform: "a remote iOS simulator",
      udid: REMOTE_UDID,
      own: remoteIosHost,
      other: localIosHost,
    },
  ])(
    "on $platform, reads the app's processes through that simulator's own host",
    async ({ udid, own, other }) => {
      serve(PORT, udid, new FakeRuntime(APP));
      await start(udid, APP);
      await reconnect(PORT, udid, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      // Only the simulator's own host knows that the app exited.
      vi.mocked(own.listRunningBundleIds).mockResolvedValue(new Set([OTHER]));
      vi.mocked(other.listRunningBundleIds).mockResolvedValue(new Set([APP, OTHER]));

      const result = await stop(udid, APP);

      expect(layer(result, "js")).toMatchObject({
        armed: false,
        reason: `no app is connected to Metro on port ${PORT} yet; ${APP} is not running, so nothing records; while capture is stopped, its next JS runtime gets no interceptor`,
      });
    }
  );

  it("waits at most 10 s for a remote simulator's process list, as for the other devices", async () => {
    serve(PORT, REMOTE_UDID, new FakeRuntime(APP));
    await start(REMOTE_UDID, APP);
    await reconnect(PORT, REMOTE_UDID, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The remote host answers only at its own 60 s limit.
      vi.mocked(remoteIosHost.listRunningBundleIds).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(new Set([OTHER])), 60_000))
      );
      let settled = false;
      const pending = stop(REMOTE_UDID, APP).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(settled).toBe(true);
      expect(layer(await pending, "js")).toEqual({
        layer: "js",
        armed: true,
        total: 0,
        reason: `no app is connected to Metro on port ${PORT} yet; the interceptor already in the app's JS runtime may still record, so call network-capture-stop again once the app answers`,
      });
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each(
    PROCESS_PLATFORMS.flatMap((platform) => [
      { ...platform, device: "lists a process of the app", answers: true },
      { ...platform, device: "does not answer", answers: false },
    ])
  )(
    "on $platform, still says the installed interceptor may record when the device $device and the app's runtime cannot be reached",
    async ({ udid, answers }) => {
      serve(PORT, udid, new FakeRuntime(APP));
      await start(udid, APP);
      await reconnect(PORT, udid, FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      if (!answers) running = undefined;

      const result = await stop(udid, APP);

      expect(layer(result, "js")).toEqual({
        layer: "js",
        armed: true,
        total: 0,
        reason: `no app is connected to Metro on port ${PORT} yet; the interceptor already in the app's JS runtime may still record, so call network-capture-stop again once the app answers`,
      });
      expect(findJsCapture(udid, APP)).toMatchObject({ intent: "stopped", installed: true });
    }
  );

  it("says the JS layer is still armed when the pause in the app's runtime throws", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    const evaluate = rt.evaluate.bind(rt);
    rt.evaluate = (expr: string) => {
      if (scriptName(expr) === "pause") throw new Error("Runtime.evaluate timed out");
      return evaluate(expr);
    };

    const result = await stop(SERIAL, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: true,
      total: 0,
      reason: "the app's JS runtime did not pause capture: Runtime.evaluate timed out",
    });
    expect(rt.paused).toBe(false);
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", installed: true });
    expect(findJsCapture(SERIAL, APP)).not.toHaveProperty("paused");
  });

  it("says the JS layer is still armed within 5 s on a runtime that does not answer the pause", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    // The runtime keeps the connection but is busy or frozen.
    rt.frozen = true;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = stop(SERIAL, APP).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(settled).toBe(true);
      expect(layer(await pending, "js")).toEqual({
        layer: "js",
        armed: true,
        total: 0,
        reason:
          "the app's JS runtime did not pause capture: Runtime.evaluate timed out after 5000 ms",
      });
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", installed: true });
  });

  it("says the JS layer confirmed the stop when only the count after the pause throws", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    rt.send("/a");
    const evaluate = rt.evaluate.bind(rt);
    rt.evaluate = (expr: string) => {
      if (scriptName(expr) === "read") throw new Error("CDP disconnected");
      return evaluate(expr);
    };

    const result = await stop(SERIAL, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      total: 0,
      reason:
        "the app's JS runtime paused capture, but did not answer the count of its requests: CDP disconnected",
    });
    expect(rt.paused).toBe(true);
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", paused: true });
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

  it("stops and reads the capture a start stored with the device id in another case", async () => {
    // list-devices prints an iOS UDID in upper case, and a caller can pass it in lower case.
    const upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const lower = upper.toLowerCase();
    const rt = new FakeRuntime(APP);
    // Metro has one runtime for the device, which a debugger reaches with either spelling.
    serve(PORT, upper, rt);
    serve(PORT, lower, rt);
    ios.connected.add(APP);
    await start(upper, APP);
    rt.send("/a");

    const started = "=== NETWORK LOGS (page 1/1, 1 total) ===";
    expect(await read(lower)).toContain(started);
    expect(await read(upper)).toContain(started);

    expect(layer(await stop(lower, APP), "js")).toEqual({ layer: "js", armed: false, total: 1 });
    expect(rt.paused).toBe(true);

    const stopped = "=== NETWORK LOGS (page 1/1, 1 total; capture stopped) ===";
    expect(await read(lower)).toContain(stopped);
    expect(await read(upper)).toContain(stopped);
    expect(jsCapturesOn(upper)).toEqual([
      expect.objectContaining({ bundleId: APP, intent: "stopped", port: PORT }),
    ]);
  });

  it("stops and reads with the serial the capture a start stored with the device's ext: id", async () => {
    const rt = new FakeRuntime(APP);
    // Metro has one runtime for the device, which a debugger reaches with either id.
    serve(PORT, EXT_ID, rt);
    serve(PORT, SERIAL, rt);
    await start(EXT_ID, APP);
    rt.send("/a");

    expect(await read(SERIAL)).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
    expect(layer(await stop(SERIAL, APP), "js")).toEqual({ layer: "js", armed: false, total: 1 });
    expect(rt.paused).toBe(true);
    expect(await read(EXT_ID)).toContain(
      "=== NETWORK LOGS (page 1/1, 1 total; capture stopped) ==="
    );
    expect(jsCapturesOn(SERIAL)).toEqual([
      expect.objectContaining({ bundleId: APP, intent: "stopped", port: PORT }),
    ]);
  });

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

describe("native-network-logs after a start that found the iOS layer unavailable", () => {
  beforeEach(() => {
    registry.registerTool(createNativeNetworkLogsTool(registry));
    serve(PORT, IOS_UDID, new FakeRuntime(APP));
  });

  function readNative() {
    return registry.invokeTool<Record<string, unknown>>("native-network-logs", {
      udid: IOS_UDID,
      bundleId: APP,
    });
  }

  it("says why the start found it unavailable, until a start turns capture on", async () => {
    ios.appState = "unregistered";
    const { reason } = layer(await start(IOS_UDID, APP), "ios-native");

    expect(await readNative()).toEqual({
      status: "ok",
      header: `ios-native: unavailable, 0 requests (${reason})`,
      armed: false,
      started: false,
      count: 0,
      total: 0,
      requests: [],
    });

    ios.appState = "stale_process";
    await start(IOS_UDID, APP);
    expect(await readNative()).toMatchObject({ status: "restart_required" });
  });

  it("says why when the start could not start the service", async () => {
    ios.factoryError = new Error("the simulator is not booted");
    const { reason } = layer(await start(IOS_UDID, APP), "ios-native");

    expect(reason).toContain("the simulator is not booted");
    expect(await readNative()).toMatchObject({
      header: `ios-native: unavailable, 0 requests (${reason})`,
      started: false,
    });
  });

  it("keeps the stop, and says why, after a start that found it unavailable", async () => {
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    await stop(IOS_UDID, APP);
    ios.connected.delete(APP);
    ios.appState = "unregistered";
    const { reason } = layer(await start(IOS_UDID, APP), "ios-native");

    expect(await readNative()).toMatchObject({
      header: `ios-native: stopped, 0 requests (capture stopped by network-capture-stop; a later network-capture-start found the layer unavailable: ${reason})`,
      stopped: true,
    });
  });

  it("forgets why at a teardown of the device", async () => {
    ios.appState = "unregistered";
    await start(IOS_UDID, APP);

    await stopAll([IOS_UDID]);

    expect(await readNative()).toMatchObject({
      header: expect.stringContaining("ios-native: not started"),
      started: false,
    });
  });
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

  it.each(PLATFORMS)(
    "on $platform, leaves another app's JS runtime on the port as it is, and keeps the app's capture stopped",
    async ({ udid, connect }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, udid, rt);
      connect();
      await start(udid, APP);
      rt.send("/before");
      const { mark } = findJsCapture(udid, APP)!;
      // Another app's runtime answers on the port now, and its debugger is live.
      const otherRuntime = new FakeRuntime(OTHER);
      await reconnect(PORT, udid, otherRuntime);
      await registry.resolveService(`JsRuntimeDebugger:${jsCapturePayload(PORT, udid)}`);

      await stopAll([udid]);

      expect(otherRuntime.evaluated).toEqual([]);
      expect(findJsCapture(udid, APP)).toEqual({
        bundleId: APP,
        intent: "stopped",
        mark,
        installed: true,
        port: PORT,
      });
      // Once the app's runtime answers again, a stop pauses it and still counts its request.
      await reconnect(PORT, udid, rt);
      expect(layer(await stop(udid, APP), "js")).toEqual({ layer: "js", armed: false, total: 1 });
      expect(rt.paused).toBe(true);
    }
  );

  it("waits at most 1 s for a JS runtime whose debugger another call is still connecting, then disposes that debugger", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    const { mark } = findJsCapture(IOS_UDID, APP)!;
    // The debugger dropped, and another call connects it again, slowly.
    await reconnect(PORT, IOS_UDID, rt);
    const urn = `JsRuntimeDebugger:${jsCapturePayload(PORT, IOS_UDID)}`;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      connectDelayMs = 3_000;
      const connecting = registry.resolveService(urn).then(
        () => "connected",
        () => "gave up"
      );
      expect(registry.getSnapshot().services.get(urn)?.state).toBe(ServiceState.STARTING);
      let settled = false;
      const pending = stopAll([IOS_UDID]).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      expect((await pending).stopped).toContain(urn);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await connecting).toBe("gave up");
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
    // The pause did not reach the runtime, so its capture stays, stopped.
    expect(jsCapture(jsCapturePayload(PORT, IOS_UDID))).toEqual({
      bundleId: APP,
      intent: "stopped",
      mark,
      installed: true,
    });
    expect(rt.paused).toBe(false);
  });

  it("ends no JS capture when the call was cancelled before it began", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.send("/a");
    const capture = structuredClone(findJsCapture(IOS_UDID, APP));
    const controller = new AbortController();
    controller.abort();

    const result = await stopAll([IOS_UDID], controller.signal);

    expect(result).toEqual({ stopped: [], aborted: true });
    expect(rt.evaluated).not.toContain("end");
    expect(rt.paused).toBe(false);
    expect(findJsCapture(IOS_UDID, APP)).toEqual(capture);
    expect(await read(IOS_UDID)).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
  });

  it("ends no JS capture when the call is cancelled while it waits for a stop under way", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    rt.send("/a");
    // The Android layer's stop takes a while.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const android = androidFor(APP);
    const stopNative = android.stopCapture.bind(android);
    android.stopCapture = async () => {
      await held;
      return stopNative();
    };
    const stopping = stop(SERIAL, APP);
    await settle();
    const controller = new AbortController();
    const sweep = stopAll([SERIAL], controller.signal);
    await settle();

    controller.abort();
    release();
    await stopping;
    const result = await sweep;

    expect(result).toEqual({ stopped: [], aborted: true });
    expect(rt.evaluated).not.toContain("end");
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped", paused: true });
    expect(await read(SERIAL)).toContain(
      "=== NETWORK LOGS (page 1/1, 1 total; capture stopped) ==="
    );
  });

  it("waits for a start under way before it pauses or disposes anything, so the start's answer holds until the teardown ends it", async () => {
    // A device service the sweep reaches first, whose dispose takes a while.
    let releaseServer!: () => void;
    const serverDisposed = new Promise<void>((resolve) => (releaseServer = resolve));
    registry.registerBlueprint({
      namespace: "SimulatorServer",
      getURN: (payload: string) => `SimulatorServer:${payload}`,
      async factory() {
        return {
          api: {},
          dispose: () => serverDisposed,
          events: new TypedEventEmitter<ServiceEvents>(),
        };
      },
    });
    await registry.resolveService(`SimulatorServer:${IOS_UDID}`);
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    // The app acknowledges Network.enable a moment later. A dispose of the service
    // before that drops the app's connection and ends the wait unarmed.
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => (acknowledge = resolve));
    let nativeDisposed = false;
    registry.events.on("serviceStateChange", (urn, _from, to) => {
      if (urn !== `NativeDevtools:${IOS_UDID}` || to !== ServiceState.TERMINATING) return;
      nativeDisposed = true;
      ios.connected.clear();
    });
    const startNative = ios.startNetworkCapture.bind(ios);
    ios.startNetworkCapture = async (...args) => {
      const armed = await startNative(...args);
      await acknowledged;
      return armed && !nativeDisposed;
    };
    // stop-all-simulator-servers comes in while the start reads the JS mark.
    let sweep: Promise<unknown> | undefined;
    const evaluate = rt.evaluate.bind(rt);
    rt.evaluate = async (expr: string) => {
      if (scriptName(expr) === "mark" && !sweep) {
        sweep = stopAll([IOS_UDID]);
        await settle();
      }
      return evaluate(expr);
    };

    const started = start(IOS_UDID, APP);
    // The JS layer installs, then the sweep goes on, then the app acknowledges.
    for (let i = 0; i < 50 && !rt.evaluated.includes("install"); i++) await settle();
    releaseServer();
    await settle();
    acknowledge();
    const result = await started;
    await sweep;

    expect(result.layers).toEqual([
      { layer: "js", armed: true },
      { layer: "ios-native", armed: true },
    ]);
    // The teardown ran after the start, so it ended the capture the start armed.
    expect(rt.evaluated.indexOf("end")).toBeGreaterThan(rt.evaluated.indexOf("install"));
    expect(rt.paused).toBe(true);
    expect(findJsCapture(IOS_UDID, APP)).toBeUndefined();
  });

  it.each([
    { scope: "the device", devices: [IOS_UDID] },
    { scope: "every device", devices: undefined },
  ])(
    "holds a start called during its teardown of $scope until the teardown ends, so the start's capture stays",
    async ({ devices }) => {
      let releaseServer!: () => void;
      const serverDisposed = new Promise<void>((resolve) => (releaseServer = resolve));
      registry.registerBlueprint({
        namespace: "SimulatorServer",
        getURN: (payload: string) => `SimulatorServer:${payload}`,
        async factory() {
          return {
            api: {},
            dispose: () => serverDisposed,
            events: new TypedEventEmitter<ServiceEvents>(),
          };
        },
      });
      await registry.resolveService(`SimulatorServer:${IOS_UDID}`);
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await start(IOS_UDID, APP);

      const sweep = stopAll(devices);
      await settle();
      expect(rt.paused).toBe(true);
      const started = start(IOS_UDID, APP);
      await settle();
      releaseServer();
      await sweep;
      const result = await started;

      expect(result.layers).toEqual([
        { layer: "js", armed: true },
        { layer: "ios-native", armed: true },
      ]);
      expect(rt.paused).toBe(false);
      expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ intent: "started", installed: true });
      rt.send("/after-start");
      expect(await read(IOS_UDID)).toContain('"GET /after-start"');
    }
  );

  it("ends the JS capture a start stored with the device's ext: id when it names the device by its serial", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, EXT_ID, rt);
    serve(PORT, SERIAL, rt);
    await start(EXT_ID, APP);
    rt.send("/a");

    await stopAll([SERIAL]);

    expect(rt.paused).toBe(true);
    expect(findJsCapture(EXT_ID, APP)).toBeUndefined();
    expect(await read(EXT_ID)).toContain("Network capture is not started for this app");
  });

  it.each(PLATFORMS)(
    "leaves the $platform native service it disposed as it is at a later stop, which says capture was not started",
    async ({ udid, native, connect }) => {
      serve(PORT, udid, new FakeRuntime(APP));
      connect();
      await start(udid, APP);
      await stopAll([udid]);
      const disposed = nativeUrns();
      expect(disposed).toHaveLength(1);

      const stopped = await stop(udid, APP);

      // The stop builds no new service, which would bind the device's socket again.
      expect(registry.getSnapshot().services.get(disposed[0]!)?.state).toBe(ServiceState.IDLE);
      expect(layer(stopped, native)).toEqual({
        layer: native,
        armed: false,
        total: 0,
        reason: NOT_STARTED,
      });
    }
  );

  it("disposes a service of the device that another call creates while the pause runs", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    await start(SERIAL, APP);
    // Another app's inspector, as a start of that app creates it.
    const created = androidNetworkInspectorRef(resolveDevice(SERIAL), OTHER, PORT);
    const evaluate = rt.evaluate.bind(rt);
    rt.evaluate = async (expr: string) => {
      if (scriptName(expr) === "end") await registry.resolveService(created.urn, created.options);
      return evaluate(expr);
    };

    const result = await stopAll([SERIAL]);

    expect(result.stopped).toContain(created.urn);
    expect(registry.getSnapshot().services.get(created.urn)?.state).toBe(ServiceState.IDLE);
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

describe("the tool-server's exit", () => {
  /** What the exit runs in each app's JS runtime, as src/index.ts calls it. */
  const exit = () => pauseJsCapturesOf(registry, undefined, { atExit: true });

  /**
   * Another tool-server process starts the app's capture in the same JS runtime. `pid` is that
   * process; it is this test's process without it.
   */
  async function otherServerStarts(
    rt: FakeRuntime,
    pid = process.pid
  ): Promise<typeof import("../src/utils/debugger/scripts/network-interceptor")> {
    const own = Object.getOwnPropertyDescriptor(process, "pid")!;
    Object.defineProperty(process, "pid", { ...own, value: pid });
    try {
      vi.resetModules();
      const other = await import("../src/utils/debugger/scripts/network-interceptor");
      rt.evaluate(other.makeNetworkCaptureControlScript(false));
      rt.evaluate(other.NETWORK_INTERCEPTOR_SCRIPT);
      return other;
    } finally {
      Object.defineProperty(process, "pid", own);
    }
  }

  /** The pid of a process that has exited. */
  const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

  it("ends the capture that a tool-server which exited without its own exit left in the app", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    // The other tool-server starts the capture, then exits while it cannot reach the app.
    await otherServerStarts(rt, exitedPid());
    rt.send("/a");
    await start(IOS_UDID, APP);

    await exit();
    rt.send("/b");

    expect(rt.paused).toBe(true);
    expect(JSON.parse(String(rt.evaluate(makeNetworkLogReadScript(0, 10, PORT))))).toMatchObject({
      total: 0,
      paused: true,
    });
  });

  it("leaves the capture as it is while another tool-server process still runs, and ends it once that process exits", async () => {
    const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const rt = new FakeRuntime(APP);
      serve(PORT, IOS_UDID, rt);
      ios.connected.add(APP);
      await otherServerStarts(rt, peer.pid!);
      await start(IOS_UDID, APP);
      rt.send("/a");

      await exit();
      rt.send("/b");

      expect(rt.paused).toBe(false);
      expect(await read(IOS_UDID)).toContain("=== NETWORK LOGS (page 1/1, 2 total) ===");

      peer.kill("SIGKILL");
      await once(peer, "exit");
      await start(IOS_UDID, APP);
      await exit();

      expect(rt.paused).toBe(true);
      expect(JSON.parse(String(rt.evaluate(makeNetworkLogReadScript(0, 10, PORT))))).toMatchObject({
        total: 0,
      });
    } finally {
      peer.kill("SIGKILL");
    }
  });

  it("leaves the capture of a tool-server on another host as it is", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.evaluate(
      `globalThis.__argent_network_holders.peer = ${JSON.stringify({
        capturing: true,
        pid: exitedPid(),
        host: `not-${hostname()}`,
      })}`
    );

    await exit();
    rt.send("/a");

    expect(rt.paused).toBe(false);
    expect(await read(IOS_UDID)).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
  });

  it("pauses and empties the JS log of an app no other tool-server captures", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.send("/a");

    await exit();

    expect(rt.paused).toBe(true);
    expect(await read(IOS_UDID)).not.toContain("rn-net-1");
  });

  it("leaves the capture as it is while another tool-server still captures the app", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    await otherServerStarts(rt);
    rt.send("/a");

    await exit();
    rt.send("/b");

    expect(rt.paused).toBe(false);
    const text = await read(IOS_UDID);
    expect(text).toContain("=== NETWORK LOGS (page 1/1, 2 total) ===");
  });

  it("keeps the log of an app it only stopped while another tool-server still reads it", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    await otherServerStarts(rt);
    rt.send("/a");
    await stop(IOS_UDID, APP);

    await exit();

    expect(await read(IOS_UDID)).toContain(
      "=== NETWORK LOGS (page 1/1, 1 total; capture stopped) ==="
    );
  });

  it("lets another tool-server's exit end a capture it started after this one stopped its own", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    rt.send("/a");
    await stop(IOS_UDID, APP);
    const other = await otherServerStarts(rt);
    rt.send("/b");

    rt.evaluate(other.makeNetworkCaptureReleaseScript([]));
    rt.send("/c");

    expect(rt.paused).toBe(true);
    // This tool-server still reads what its stop kept.
    const text = await read(IOS_UDID);
    expect(text).toContain("=== NETWORK LOGS (page 1/1, 2 total; capture stopped) ===");
    expect(text).not.toContain("/c");
  });

  it("lets another tool-server's exit end the capture once stop-all-simulator-servers ended this one's", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, rt);
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    const other = await otherServerStarts(rt);
    await stopAll([IOS_UDID]);
    // The other tool-server captures again, then exits.
    rt.evaluate(other.makeNetworkCaptureControlScript(false));
    rt.send("/a");

    rt.evaluate(other.makeNetworkCaptureReleaseScript([]));

    expect(rt.paused).toBe(true);
    expect(JSON.parse(String(rt.evaluate(makeNetworkLogReadScript(0, 10, PORT))))).toMatchObject({
      total: 0,
    });
  });
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
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; if that runtime is the app, pass bundleId ${OTHER}; otherwise pass the port of ${APP}'s Metro`,
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

  it("does not say an interceptor may still record when an earlier stop already paused it", async () => {
    serve(PORT, IOS_UDID, new FakeRuntime(APP));
    ios.connected.add(APP);
    await start(IOS_UDID, APP);
    expect(layer(await stop(IOS_UDID, APP), "js")).toMatchObject({ armed: false });
    await reconnect(PORT, IOS_UDID, new FakeRuntime(OTHER));
    const paused = {
      layer: "js",
      armed: false,
      total: 0,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; while capture is stopped, ${APP}'s JS runtime gets no interceptor`,
    };

    // Each stop there keeps the pause the first one confirmed.
    expect(layer(await stop(IOS_UDID, APP), "js")).toEqual(paused);
    expect(layer(await stop(IOS_UDID, APP), "js")).toEqual(paused);
    expect(findJsCapture(IOS_UDID, APP)).toMatchObject({
      intent: "stopped",
      installed: true,
      paused: true,
    });
  });

  it.each(PLATFORMS)(
    "on $platform, stores the stop of this app's started capture there, and says nothing records, when the app is not running",
    async ({ udid }) => {
      serve(PORT, udid, new FakeRuntime(APP));
      await start(udid, APP);
      const otherRuntime = new FakeRuntime(OTHER);
      await reconnect(PORT, udid, otherRuntime);
      running = new Set([OTHER]);

      const stopped = await stop(udid, APP);

      expect(layer(stopped, "js")).toEqual({
        layer: "js",
        armed: false,
        total: 0,
        reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; ${APP} is not running, so nothing records; while capture is stopped, its next JS runtime gets no interceptor`,
      });
      expect(findJsCapture(udid, APP)).toMatchObject({
        port: PORT,
        intent: "stopped",
        installed: false,
      });
      expect(otherRuntime.evaluated).toEqual([]);
    }
  );

  it("gets nothing from a stop and a start of this app, and a read then gives the start's reason", async () => {
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
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s, so nothing changed there; if that runtime is the app, pass bundleId ${OTHER}; otherwise pass the port of ${APP}'s Metro`,
    });
    expect(layer(started, "js")).toMatchObject({ armed: false, unavailable: true });
    expect(jsCapturesOn(IOS_UDID)).toEqual([]);
    expect(rt.evaluated).toEqual([]);
    expect(urns()).not.toContain(`NetworkInspector:${jsCapturePayload(PORT, IOS_UDID)}`);
    expect(text).toBe(
      `Network capture is not started on the JS layer: network-capture-start for ${APP} found it unavailable (${layer(started, "js").reason}). native-network-logs lists the requests of the native layer. Once the JS layer can start, call network-capture-start again, repeat the action, then call view-network-logs again.`
    );
  });
});

describe("a Metro that several devices share", () => {
  /** This device's runtime answers only to its logicalDeviceId, as on a shared Metro. */
  function shared(): FakeRuntime {
    const rt = new FakeRuntime(APP);
    serve(PORT, IOS_UDID, FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH);
    serve(PORT, SHARED_ID, rt);
    ios.connected.add(APP);
    return rt;
  }

  it("arms the JS layer on the runtime that logicalDeviceId names, which view-network-logs then reads", async () => {
    const rt = shared();

    const result = await start(IOS_UDID, APP, undefined, SHARED_ID);

    expect(result.layers).toEqual([
      { layer: "js", armed: true },
      { layer: "ios-native", armed: true },
    ]);
    expect(findJsCapture(SHARED_ID, APP)).toMatchObject({ intent: "started", installed: true });
    expect(findJsCapture(IOS_UDID, APP)).toBeUndefined();
    rt.send("/shared");
    const logs = await read(SHARED_ID);
    expect(logs).toContain("=== NETWORK LOGS (page 1/1, 1 total) ===");
    expect(logs).toContain("/shared");
  });

  it("stops the JS layer with the same logicalDeviceId, and a stop without it leaves that runtime recording", async () => {
    const rt = shared();
    await start(IOS_UDID, APP, undefined, SHARED_ID);

    const without = await stop(IOS_UDID, APP);
    expect(layer(without, "js")).toMatchObject({ armed: false });
    expect(rt.paused).toBe(false);

    const stopped = await stop(IOS_UDID, APP, undefined, SHARED_ID);
    expect(layer(stopped, "js")).toEqual({ layer: "js", armed: false, total: 0 });
    expect(rt.paused).toBe(true);
    expect(findJsCapture(SHARED_ID, APP)).toMatchObject({ intent: "stopped" });
  });

  it("names the logicalDeviceIds to pass when the start gives none, and the native layer still arms", async () => {
    shared();

    const result = await start(IOS_UDID, APP);

    expect(layer(result, "js")).toEqual({
      layer: "js",
      armed: false,
      unavailable: true,
      reason: `several devices are connected to Metro on port ${PORT}, so the JS layer cannot tell which runtime is this device's; pass this device's logicalDeviceId (in parentheses: ${SHARED_DEVICES}), or give each device its own Metro port`,
    });
    expect(layer(result, "ios-native")).toEqual({ layer: "ios-native", armed: true });
  });

  it("is stopped by stop-all-simulator-servers only when its devices name the logicalDeviceId", async () => {
    const rt = shared();
    await start(IOS_UDID, APP, undefined, SHARED_ID);

    await stopAll([IOS_UDID]);
    expect(rt.paused).toBe(false);
    expect(findJsCapture(SHARED_ID, APP)).toMatchObject({ intent: "started" });

    await stopAll([IOS_UDID, SHARED_ID]);
    expect(rt.paused).toBe(true);
    expect(findJsCapture(SHARED_ID, APP)).toBeUndefined();
  });

  it("opens a remote simulator's sim-remote tunnel by its udid, and finds the runtime by logicalDeviceId", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, REMOTE_UDID, FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH);
    serve(PORT, SHARED_ID, rt);
    vi.mocked(proxyStart).mockClear();

    const result = await start(REMOTE_UDID, APP, undefined, SHARED_ID);
    expect(layer(result, "js")).toEqual({ layer: "js", armed: true });
    expect(vi.mocked(proxyStart).mock.calls).toEqual([[REMOTE_UDID, PORT]]);

    expect(layer(await stop(REMOTE_UDID, APP, undefined, SHARED_ID), "js")).toMatchObject({
      armed: false,
    });
    expect(vi.mocked(proxyStart).mock.calls).toEqual([
      [REMOTE_UDID, PORT],
      [REMOTE_UDID, PORT],
    ]);
    expect(rt.paused).toBe(true);
  });

  it("refuses an empty logicalDeviceId before any layer runs", async () => {
    shared();

    await expect(start(IOS_UDID, APP, undefined, "")).rejects.toThrow(/logicalDeviceId/);
    expect(findJsCapture(SHARED_ID, APP)).toBeUndefined();
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

  it("stays as it is when stopped there, through a start against another app's runtime, which names its port", async () => {
    await startedOnNewPort();
    await stop(IOS_UDID, APP, NEW_PORT);
    const capture = findJsCapture(IOS_UDID, APP);
    expect(capture).toMatchObject({ intent: "stopped", installed: true, paused: true });
    serve(PORT, IOS_UDID, new FakeRuntime(OTHER));

    const started = await start(IOS_UDID, APP);

    expect(layer(started, "js")).toEqual({
      layer: "js",
      armed: false,
      unavailable: true,
      reason: `the JS runtime on Metro port ${PORT} is ${OTHER}'s, not ${APP}'s; ${hint}`,
    });
    expect(jsCapturesOn(IOS_UDID)).toEqual([capture]);
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

  it.each([
    { there: "Metro is down", answer: undefined },
    { there: "another app's runtime answers", answer: () => new FakeRuntime(OTHER) },
    { there: "no app is connected", answer: () => FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS },
    {
      there: "another app's capture is on the port",
      answer: () => new FakeRuntime(OTHER),
      otherStarts: true,
    },
  ])(
    "says a stop on another port may leave it recording after a stop on its own port did not reach it, when $there",
    async ({ answer, otherStarts }) => {
      const rt = await startedOnNewPort();
      await reconnect(NEW_PORT, IOS_UDID, undefined);
      expect(layer(await stop(IOS_UDID, APP, NEW_PORT), "js")).toMatchObject({ armed: true });
      serve(PORT, IOS_UDID, answer?.());
      if (otherStarts) await start(IOS_UDID, OTHER);

      const stopped = await stop(IOS_UDID, APP);

      expect(layer(stopped, "js")).toMatchObject({ armed: true, total: 0 });
      expect(layer(stopped, "js").reason).toContain(hint);
      expect(rt.paused).toBe(false);
    }
  );

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
    let release: (() => void) | undefined;
    androidFor(packageName).startAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve({ armed: true });
      });
    return { release: () => release?.() };
  }

  it("run one after the other also when the stop comes while the start looks up adb, so the JS layer ends paused", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    let release!: () => void;
    adbLookup.hold = new Promise((resolve) => (release = resolve));
    __resetDepCacheForTests();

    const starting = start(SERIAL, APP);
    await vi.waitFor(() => expect(adbLookup.reached).toBe(true));
    const stopping = stop(SERIAL, APP);
    await settle();
    // The start's JS layer does not wait for adb, but the stop waits for the whole start.
    expect(rt.evaluated).not.toContain("pause");

    release();
    await starting;
    const stopped = await stopping;

    expect(layer(stopped, "js")).toEqual({ layer: "js", armed: false, total: 0 });
    expect(rt.paused).toBe(true);
    expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "stopped" });
  });

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

  it.each([
    { how: "with no devices", udid: SERIAL, devices: undefined },
    { how: "with the serial in another case", udid: SERIAL, devices: ["EMULATOR-5554"] },
    {
      how: "with the serial, for a start under a logicalDeviceId Metro gave the device",
      udid: LOGICAL_ID,
      devices: [SERIAL],
    },
    { how: "with a serial that has a colon", udid: WIFI_SERIAL, devices: [WIFI_SERIAL] },
    {
      how: "with the serial, for a start under the device's ext: id",
      udid: EXT_ID,
      devices: [SERIAL],
    },
  ])("hold stop-all-simulator-servers $how until they end", async ({ udid, devices }) => {
    const device = udid === LOGICAL_ID ? SERIAL : udid;
    if (udid === LOGICAL_ID) rememberDeviceAlias(LOGICAL_ID, SERIAL);
    const rt = new FakeRuntime(APP);
    serve(PORT, device, rt);
    const held = holdStart(APP);
    try {
      const starting = start(udid, APP);
      await vi.waitFor(() => expect(androidFor(APP).calls).toEqual([`start ${PORT}`]));
      let swept = false;
      const sweep = stopAll(devices).finally(() => {
        swept = true;
      });
      await settle();

      expect(swept).toBe(false);
      expect(rt.evaluated).not.toContain("end");

      held.release();
      await starting;
      await sweep;

      expect(rt.evaluated.indexOf("end")).toBeGreaterThan(rt.evaluated.indexOf("install"));
      expect(findJsCapture(device, APP)).toBeUndefined();
    } finally {
      held.release();
      forgetDeviceAlias(LOGICAL_ID);
    }
  });

  it("let a stop-all-simulator-servers that is cancelled while it waits for them end at once, with nothing stopped", async () => {
    const rt = new FakeRuntime(APP);
    serve(PORT, SERIAL, rt);
    const held = holdStart(APP);
    const inspector = androidNetworkInspectorRef(resolveDevice(SERIAL), APP, PORT).urn;
    try {
      const starting = start(SERIAL, APP);
      await vi.waitFor(() => expect(androidFor(APP).calls).toEqual([`start ${PORT}`]));
      const controller = new AbortController();
      let swept = false;
      const sweep = stopAll([SERIAL], controller.signal).finally(() => {
        swept = true;
      });
      await settle();
      controller.abort();
      await settle();

      expect(swept).toBe(true);
      expect(await sweep).toEqual({ stopped: [], aborted: true });

      held.release();
      expect(layer(await starting, "js")).toEqual({ layer: "js", armed: true });
      await settle();
      expect(rt.evaluated).not.toContain("end");
      expect(findJsCapture(SERIAL, APP)).toMatchObject({ intent: "started", installed: true });
      expect(registry.getSnapshot().services.get(inspector)?.state).toBe(ServiceState.RUNNING);
    } finally {
      held.release();
    }
  });

  it("let stop-all-simulator-servers end when it comes in while a second start of the app waits behind the first", async () => {
    // An app of its own, so a lock this test leaves held holds up no other test.
    const app = "com.example.queued";
    serve(PORT, SERIAL, new FakeRuntime(app));
    const held = holdStart(app);

    const first = start(SERIAL, app);
    await vi.waitFor(() => expect(androidFor(app).calls).toEqual([`start ${PORT}`]));
    // The second start waits on the lock before the sweep comes in.
    const second = start(SERIAL, app);
    await settle();
    const sweep = stopAll([SERIAL]);
    await settle();
    held.release();
    // The second start runs once the first ends, and the sweep waits for it.
    await vi.waitFor(() =>
      expect(androidFor(app).calls).toEqual([`start ${PORT}`, `start ${PORT}`])
    );
    held.release();

    await expect(first).resolves.toMatchObject({ status: "ok" });
    await expect(second).resolves.toMatchObject({ status: "ok" });
    expect((await sweep).stopped).toContain(
      androidNetworkInspectorRef(resolveDevice(SERIAL), app, PORT).urn
    );
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

describe("a device the capture tools do not cover", () => {
  // A call made inside the tool-server, as an e2e `tool:` step makes it, skips the HTTP gate.
  it.each([
    { platform: "Vega", udid: "amazon-0123456789" },
    { platform: "Chromium", udid: "chromium-cdp-9222" },
  ])(
    "on $platform, refuses a start and a stop called inside the tool-server, and leaves the app's JS runtime as it is",
    async ({ udid }) => {
      const rt = new FakeRuntime(APP);
      serve(PORT, udid, rt);

      for (const call of [start, stop]) {
        const err = await call(udid, APP).then(
          () => undefined,
          (e: unknown) => e
        );
        expect((err as Error | undefined)?.cause).toBeInstanceOf(UnsupportedOperationError);
        expect(String(err)).toContain("network capture has no start or stop");
      }

      expect(rt.evaluated).toEqual([]);
      expect(rt.paused).toBeUndefined();
      expect(jsCapturesOn(udid)).toEqual([]);
    }
  );
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
    "network-capture-$verb.2 refuses a bundleId outside the app id alphabet before any layer runs",
    async ({ verb }) => {
      serve(PORT, IOS_UDID, new FakeRuntime(APP));
      const call = verb[2] === "start" ? start : stop;

      for (const bundleId of [`${APP} `, `${APP}/.MainActivity`, ""]) {
        const err = await call(IOS_UDID, bundleId).then(
          () => undefined,
          (e: unknown) => e as Error
        );

        expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
        expect(err?.message).toContain(BUNDLE_ID_MESSAGE);
      }
      expect(jsCapturesOn(IOS_UDID)).toEqual([]);
      expect(urns()).toEqual([]);
    }
  );

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
