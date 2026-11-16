import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Every adb call answers like a successful `am start -W`, and each is logged so
// a test can tell whether the attach ran after the app started.
const shellCalls: string[] = [];
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    adbShell: vi.fn(async (_serial: string, cmd: string) => {
      shellCalls.push(cmd);
      return "Status: ok\n";
    }),
  };
});

// Shell calls made before the attach ran, per call.
const shellCallsAtAttach: string[][] = [];
const attach = vi.fn<(deviceId: string, packageName: string) => Promise<string | undefined>>();
vi.mock("../src/blueprints/android-network-inspector", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/android-network-inspector")>()),
  attachAndroidNetworkInspectorToLaunch: (deviceId: string, packageName: string) => {
    shellCallsAtAttach.push([...shellCalls]);
    return attach(deviceId, packageName);
  },
}));

// The iOS cases run on a local simulator. Every simctl call is answered here:
// `launchctl list` and `ps` describe the launched app's process, and
// `simctl launch` can stand in for that process dialing the service.
type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;
const sim = vi.hoisted(() => ({
  /** Every command run, as `<cmd> <args...>`, in order. */
  calls: [] as string[],
  /** What `launchctl list` prints inside the simulator. */
  launchctlList: "",
  /** `launchctl list` fails, as on a simulator that stopped answering. */
  launchctlFails: false,
  /** While set, `launchctl list` answers only once it resolves, as a slow simulator does. */
  launchctlHeld: null as Promise<void> | null,
  /** What `ps` prints for the app's process. */
  psOutput: "",
  /** While set, `ps` answers only once it resolves, as a slow read of a process does. */
  psHeld: null as Promise<void> | null,
  /** Runs when the app is launched: the new process starting up. */
  onLaunch: null as (() => void) | null,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const argv = args.join(" ");
      sim.calls.push(`${cmd} ${argv}`);
      if (/\bps$/.test(cmd)) {
        const answer = () => callback(null, { stdout: sim.psOutput, stderr: "" });
        if (sim.psHeld) void sim.psHeld.then(answer);
        else answer();
        return;
      }
      if (argv.includes("launchctl list")) {
        const answer = () => {
          if (sim.launchctlFails) {
            callback(new Error("Invalid device: the simulator did not answer"), {
              stdout: "",
              stderr: "",
            });
            return;
          }
          callback(null, { stdout: sim.launchctlList, stderr: "" });
        };
        if (sim.launchctlHeld) void sim.launchctlHeld.then(answer);
        else answer();
        return;
      }
      if (argv.includes("simctl list")) {
        callback(null, { stdout: JSON.stringify({ devices: {} }), stderr: "" });
        return;
      }
      if (argv.includes("simctl launch")) sim.onLaunch?.();
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

vi.mock("../src/utils/ios-devices", async (importActual) => ({
  ...(await importActual<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

import type { Registry } from "@argent/registry";
import { androidImpl as launchAndroid } from "../src/tools/launch-app/platforms/android";
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";
import { makeIosImpl as makeLaunchIosImpl } from "../src/tools/launch-app/platforms/ios";
import { makeIosImpl as makeRestartIosImpl } from "../src/tools/restart-app/platforms/ios";
import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import {
  androidNetworkInspectorBlueprint,
  androidNetworkInspectorRef,
} from "../src/blueprints/android-network-inspector";
import { resolveDevice } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const SERIAL = "emulator-5554";
const PKG = "com.example.networktest";
const NOTE = "native network capture is attached to com.example.networktest";

const tools = [
  {
    name: "launch-app",
    run: () =>
      launchAndroid.handler(
        {} as never,
        { udid: SERIAL, bundleId: PKG, activity: ".MainActivity" },
        {} as never
      ),
    ok: { launched: true, bundleId: PKG },
  },
  {
    name: "restart-app",
    run: () =>
      restartAndroid.handler(
        {} as never,
        { udid: SERIAL, bundleId: PKG, activity: ".MainActivity" },
        {} as never
      ),
    ok: { restarted: true, bundleId: PKG },
  },
] as const;

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shellCalls.length = 0;
  shellCallsAtAttach.length = 0;
  attach.mockReset();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

describe.each(tools)("$name on Android follows native network capture", ({ run, ok }) => {
  it("attaches capture to the launched app after it started and returns the note", async () => {
    attach.mockResolvedValue(NOTE);

    const result = await run();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(SERIAL, PKG);
    expect(shellCallsAtAttach[0]!.some((cmd) => cmd.includes("am start -W"))).toBe(true);
    expect(result).toEqual({ ...ok, networkCapture: NOTE });
  });

  it("returns no networkCapture field when capture is not live for the app", async () => {
    attach.mockResolvedValue(undefined);

    const result = await run();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ok);
    expect(result).not.toHaveProperty("networkCapture");
  });

  it("still succeeds when the attach rejects", async () => {
    attach.mockRejectedValue(new Error("adb went away"));

    const result = await run();

    expect(result).toEqual(ok);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("adb went away");
  });

  it("still succeeds when the attach throws before it returns a promise", async () => {
    attach.mockImplementation(() => {
      throw new Error("synchronous failure");
    });

    const result = await run();

    expect(result).toEqual(ok);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("synchronous failure");
  });

  it("says capture is stopped, and attaches nothing, after network-capture-stop", async () => {
    const actual = await vi.importActual<
      typeof import("../src/blueprints/android-network-inspector")
    >("../src/blueprints/android-network-inspector");
    attach.mockImplementation(actual.attachAndroidNetworkInspectorToLaunch);
    const ref = androidNetworkInspectorRef(resolveDevice(SERIAL), PKG, 8081);
    const inspector = await androidNetworkInspectorBlueprint.factory(
      {},
      ref.urn.slice(ref.urn.indexOf(":") + 1),
      ref.options
    );
    try {
      await expect(inspector.api.stopCapture()).resolves.toEqual({ confirmed: true });

      const result = await run();

      expect(result).toEqual({
        ...ok,
        networkCapture: `native network capture is stopped for ${PKG} (network-capture-stop); this process runs without it until network-capture-start`,
      });
      // The launch ran no adb command for capture.
      expect(shellCalls).toEqual(shellCallsAtAttach[0]);
    } finally {
      await inspector.dispose();
    }
  });
});

const IOS_UDID = processScopedUdid("-4E7C-4A1B-9F3D-0C5A8B2E6D41");
const APP = "com.example.networktest";
const PID = 4242;
const ARMED_NOTE = `native network capture is armed for ${APP} (pid ${PID}); network-capture-stop ends it`;
const STOPPED_NOTE = `native network capture is stopped for ${APP} (network-capture-stop); this process runs without it until network-capture-start`;
/** The Metro port the app's capture is started with. */
const METRO_PORT = 8081;
const NOT_CONNECTED_NOTE = `native network capture is on for ${APP}, and its new process has not connected yet; native-network-logs shows when it is armed`;
/** The launched process's wait, as the service documents it. */
const LAUNCH_ARM_WAIT_MS = 5_000;

/** One `launchctl list` row in the real `<pid>\t<status>\t<label>` shape. */
function runningRow(pid: number, bundleId = APP): string {
  return `${pid}\t0\tUIKitApplication:${bundleId}[a1b2][rb-legacy]\n`;
}

/**
 * `ps eww -p <pid> -o etime=,command=` output: age, then argv and environment.
 * A process launched while the service runs carries its injection.
 */
function psLine(etime = "00:02", { injected = true }: { injected?: boolean } = {}): string {
  const injection = injected
    ? ` DYLD_INSERT_LIBRARIES=/fake/dylibs/libArgentInjectionBootstrap.dylib NATIVE_DEVTOOLS_IOS_CDP_SOCKET=/tmp/argent-nd-${IOS_UDID.slice(0, 8)}.sock`
    : "";
  return `${etime} /Devices/${IOS_UDID}/NetworkTest.app/NetworkTest HOME=/tmp${injection}\n`;
}

/** What the host answers before each iOS case: the app runs as PID. */
function resetSimulator(): void {
  sim.calls.length = 0;
  sim.launchctlList = runningRow(PID);
  sim.launchctlFails = false;
  sim.launchctlHeld = null;
  sim.psOutput = psLine();
  sim.psHeld = null;
  sim.onLaunch = null;
}

interface FakeApp {
  /** Every frame the service sent the app. */
  received: Array<{ type?: string; payload?: { id?: number; method?: string } }>;
  close(): void;
}

/**
 * Dials the service as the app's in-app agent does. It acknowledges each CDP
 * request unless `acknowledge` is false, which leaves Network.enable unanswered.
 * With `refuse`, it answers each CDP request with that error message.
 */
function connectApp(
  socketPath: string,
  { acknowledge = true, refuse }: { acknowledge?: boolean; refuse?: string } = {}
): Promise<FakeApp> {
  return new Promise((resolve, reject) => {
    const received: FakeApp["received"] = [];
    let buffer = "";
    const sock = net.createConnection(socketPath, () => {
      sock.write(JSON.stringify({ type: "Control", payload: { bundleId: APP } }) + "\n");
      resolve({ received, close: () => sock.destroy() });
    });
    sock.once("error", reject);
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const frame = JSON.parse(line) as FakeApp["received"][number];
        received.push(frame);
        if (acknowledge && frame.type === "CDP" && frame.payload?.id !== undefined) {
          const reply = refuse ? { error: { message: refuse } } : { result: {} };
          sock.write(
            JSON.stringify({ type: "CDP", payload: { id: frame.payload.id, ...reply } }) + "\n"
          );
        }
      }
    });
  });
}

/** Connects the fake app and waits until the service has taken its handshake. */
async function dial(api: NativeDevtoolsApi, options?: { acknowledge?: boolean; refuse?: string }) {
  const app = await connectApp(api.socketPath, options);
  await vi.waitFor(() => expect(api.isConnected(APP)).toBe(true));
  return app;
}

const askedToEnable = (app: FakeApp): boolean =>
  app.received.some((frame) => frame.type === "CDP" && frame.payload?.method === "Network.enable");

const enableRequests = (app: FakeApp): number =>
  app.received.filter((frame) => frame.type === "CDP" && frame.payload?.method === "Network.enable")
    .length;

/**
 * Runs `run` against the real native-devtools service for IOS_UDID, then
 * disposes it unless `run` already did through the `dispose` it was given.
 */
async function withService(
  run: (api: NativeDevtoolsApi, dispose: () => Promise<void>) => Promise<void>
): Promise<void> {
  const device = resolveDevice(IOS_UDID);
  const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
  let disposing: Promise<void> | undefined;
  const dispose = () => (disposing ??= instance.dispose());
  try {
    await run(instance.api as NativeDevtoolsApi, dispose);
  } finally {
    vi.useRealTimers();
    await dispose();
  }
}

/**
 * Resolves once `networkCaptureAfterLaunch` has started its wait on the fake
 * clock, which it does once the host has read the launched process.
 */
async function launchWaitStarted(): Promise<void> {
  // Only the timers are fake, so the real clock bounds this.
  const deadline = performance.now() + 2_000;
  while (vi.getTimerCount() === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

/**
 * Calls `networkCaptureAfterLaunch` on a fake clock and moves the clock past
 * the launch wait once the wait has started, checking it had not given up
 * before then.
 */
async function afterTheLaunchWait(call: () => Promise<string | undefined>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const pending = call();
    pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await launchWaitStarted();
    await vi.advanceTimersByTimeAsync(LAUNCH_ARM_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function launchCalls(): string[] {
  return sim.calls.filter((call) => call.includes("simctl launch"));
}

const probeCalls = (): string[] => sim.calls.filter((call) => call.includes("launchctl list"));

const iosTools = [
  {
    name: "launch-app",
    impl: makeLaunchIosImpl,
    ok: { launched: true, bundleId: APP },
  },
  {
    name: "restart-app",
    impl: makeRestartIosImpl,
    ok: { restarted: true, bundleId: APP },
  },
] as const;

/** A native-devtools service whose launch note the test chooses. */
function stubService(note: () => Promise<string | undefined>) {
  const networkCaptureAfterLaunch = vi.fn(note);
  const api = {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    armsEnv: true,
    withdrawEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    appConnectionState: async () => "connected",
    startNetworkCapture: async () => false,
    stopNetworkCapture: async () => ({ confirmed: true }),
    isNetworkCaptureStarted: () => false,
    isNetworkCaptureStopped: () => false,
    networkCaptureMark: () => undefined,
    refreshLentNetworkCapture: async () => {},
    takeCaptureGap: () => false,
    networkRecords: () => undefined,
    networkCaptureAfterLaunch,
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  } as NativeDevtoolsApi;
  const resolveService = vi.fn(async () => api as unknown);
  return {
    registry: { resolveService } as unknown as Registry,
    resolveService,
    networkCaptureAfterLaunch,
  };
}

describe.each(iosTools)(
  "$name on a local iOS simulator follows native network capture",
  ({ impl, ok }) => {
    beforeEach(() => {
      resetSimulator();
      __resetDepCacheForTests();
      __primeDepCacheForTests(["xcrun"]);
    });

    it("returns the note the native-devtools service gives for the launched process", async () => {
      let launchedFirst = false;
      const { registry, networkCaptureAfterLaunch } = stubService(async () => {
        launchedFirst = launchCalls().length === 1;
        return ARMED_NOTE;
      });

      const result = await impl(registry).handler(
        {},
        { udid: IOS_UDID, bundleId: APP },
        resolveDevice(IOS_UDID)
      );

      expect(result).toEqual({ ...ok, networkCapture: ARMED_NOTE });
      expect(networkCaptureAfterLaunch).toHaveBeenCalledTimes(1);
      expect(networkCaptureAfterLaunch).toHaveBeenCalledWith(APP);
      // The note is about the new process, so it is asked for once it was launched.
      expect(launchedFirst).toBe(true);
    });

    it("returns no networkCapture field when capture is off for the app", async () => {
      const { registry, networkCaptureAfterLaunch } = stubService(async () => undefined);

      const result = await impl(registry).handler(
        {},
        { udid: IOS_UDID, bundleId: APP },
        resolveDevice(IOS_UDID)
      );

      expect(networkCaptureAfterLaunch).toHaveBeenCalledTimes(1);
      expect(result).toEqual(ok);
      expect(result).not.toHaveProperty("networkCapture");
    });
  }
);

describe.each(iosTools)(
  "$name on a provider's iOS simulator leaves native network capture alone",
  ({ impl, ok }) => {
    const PROVIDER_ID = "acme-3f2a9c";
    let descriptorDir: string;

    beforeEach(() => {
      resetSimulator();
      __resetDepCacheForTests();
      __primeDepCacheForTests(["xcrun"]);
      descriptorDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-launch-capture-claim-"));
      const descriptorPath = path.join(descriptorDir, "acme.json");
      fs.writeFileSync(
        descriptorPath,
        JSON.stringify({
          devices: [
            {
              capabilities: ["simctl"],
              kind: "simulator",
              name: "iPhone 16 Pro",
              nativeId: IOS_UDID,
              platform: "ios",
              state: "Booted",
            },
          ],
          id: PROVIDER_ID,
          name: "Acme IDE",
          schemaVersion: 1,
        })
      );
      process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
      delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
      __resetExternalDeviceCacheForTesting();
      __resetProviderWarningsForTesting();
    });

    afterEach(() => {
      delete process.env.ARGENT_DEVICE_PROVIDERS;
      process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
      __resetExternalDeviceCacheForTesting();
      fs.rmSync(descriptorDir, { force: true, recursive: true });
    });

    it.each([
      ["the ext: id", () => makeExternalId(PROVIDER_ID, IOS_UDID)],
      ["the raw udid", () => IOS_UDID],
    ])("asks for no note and returns none through %s", async (_label, udidOf) => {
      const udid = udidOf();
      const { registry, resolveService, networkCaptureAfterLaunch } = stubService(
        async () => ARMED_NOTE
      );

      const result = await impl(registry).handler({}, { udid, bundleId: APP }, resolveDevice(udid));

      expect(result).toEqual(ok);
      expect(result).not.toHaveProperty("networkCapture");
      expect(resolveService).not.toHaveBeenCalled();
      expect(networkCaptureAfterLaunch).not.toHaveBeenCalled();
      expect(launchCalls()).toHaveLength(1);
    });
  }
);

describe.each(iosTools)(
  "$name on a local iOS simulator with the real native-devtools service",
  ({ impl, ok }) => {
    beforeEach(() => {
      resetSimulator();
      __resetDepCacheForTests();
      __primeDepCacheForTests(["xcrun"]);
    });

    const registryFor = (api: NativeDevtoolsApi) =>
      ({ resolveService: vi.fn(async () => api as unknown) }) as unknown as Registry;

    it("says capture is armed in the new process once it connects and acknowledges", async () => {
      await withService(async (api) => {
        // Capture was turned on while the app was not running.
        await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
        let app: Promise<FakeApp> | undefined;
        sim.onLaunch = () => {
          app = connectApp(api.socketPath);
        };

        const result = await impl(registryFor(api)).handler(
          {},
          { udid: IOS_UDID, bundleId: APP },
          resolveDevice(IOS_UDID)
        );

        expect(result).toEqual({ ...ok, networkCapture: ARMED_NOTE });
        expect(app).toBeDefined();
        const connected = await app!;
        expect(askedToEnable(connected)).toBe(true);
        connected.close();
      });
    });

    it("returns no networkCapture field when capture is off for the app", async () => {
      await withService(async (api) => {
        let app: Promise<FakeApp> | undefined;
        sim.onLaunch = () => {
          app = connectApp(api.socketPath);
        };

        const result = await impl(registryFor(api)).handler(
          {},
          { udid: IOS_UDID, bundleId: APP },
          resolveDevice(IOS_UDID)
        );

        expect(result).toEqual(ok);
        const connected = await app!;
        await vi.waitFor(() => expect(api.isConnected(APP)).toBe(true));
        expect(askedToEnable(connected)).toBe(false);
        connected.close();
      });
    });

    it("says capture is stopped, and does not arm the new process, after network-capture-stop", async () => {
      await withService(async (api) => {
        await api.startNetworkCapture(APP, METRO_PORT);
        await expect(api.stopNetworkCapture(APP)).resolves.toEqual({ confirmed: true });
        let app: Promise<FakeApp> | undefined;
        sim.onLaunch = () => {
          app = connectApp(api.socketPath);
        };

        const result = await impl(registryFor(api)).handler(
          {},
          { udid: IOS_UDID, bundleId: APP },
          resolveDevice(IOS_UDID)
        );

        expect(result).toEqual({ ...ok, networkCapture: STOPPED_NOTE });
        const connected = await app!;
        await vi.waitFor(() => expect(api.isConnected(APP)).toBe(true));
        // Time for a Network.enable on its way to arrive.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(askedToEnable(connected)).toBe(false);
        connected.close();
      });
    });

    it("arms the new process again once network-capture-start follows the stop", async () => {
      await withService(async (api) => {
        await api.startNetworkCapture(APP, METRO_PORT);
        await api.stopNetworkCapture(APP);
        await api.startNetworkCapture(APP, METRO_PORT);
        let app: Promise<FakeApp> | undefined;
        sim.onLaunch = () => {
          app = connectApp(api.socketPath);
        };

        const result = await impl(registryFor(api)).handler(
          {},
          { udid: IOS_UDID, bundleId: APP },
          resolveDevice(IOS_UDID)
        );

        expect(result).toEqual({ ...ok, networkCapture: ARMED_NOTE });
        const connected = await app!;
        expect(askedToEnable(connected)).toBe(true);
        connected.close();
      });
    });

    it("still launches when the simulator cannot say which process was launched", async () => {
      await withService(async (api) => {
        await api.startNetworkCapture(APP, METRO_PORT);
        sim.launchctlFails = true;
        let app: Promise<FakeApp> | undefined;
        sim.onLaunch = () => {
          app = connectApp(api.socketPath);
        };

        const result = await impl(registryFor(api)).handler(
          {},
          { udid: IOS_UDID, bundleId: APP },
          resolveDevice(IOS_UDID)
        );

        expect(launchCalls()).toHaveLength(1);
        // Capture is still on, so the result says so, without a pid.
        expect(result).toEqual({
          ...ok,
          networkCapture: `native network capture is armed for ${APP}; network-capture-stop ends it`,
        });
        (await app!).close();
      });
    });
  }
);

describe("networkCaptureAfterLaunch on a local iOS simulator", () => {
  beforeEach(() => {
    resetSimulator();
  });

  it("answers nothing, without probing the simulator or waiting, while capture is off", async () => {
    await withService(async (api) => {
      const probesBefore = probeCalls().length;
      const started = performance.now();

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBeUndefined();

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(probeCalls()).toHaveLength(probesBefore);
    });
  });

  it("says at once, without probing the simulator, that capture is stopped after network-capture-stop", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture(APP, METRO_PORT);
      await api.stopNetworkCapture(APP);
      const probesBefore = probeCalls().length;
      const started = performance.now();

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBe(STOPPED_NOTE);

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(probeCalls()).toHaveLength(probesBefore);
    });
  });

  it("answers nothing for an app other than the one capture is on for", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture("com.example.other", METRO_PORT);

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBeUndefined();
    });
  });

  it("says capture is armed, with the pid, for a connected process that acknowledged", async () => {
    await withService(async (api) => {
      const app = await dial(api);
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(true);

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBe(ARMED_NOTE);
      expect(askedToEnable(app)).toBe(true);
      app.close();
    });
  });

  it("says capture is armed for a process that connects only after the launch", async () => {
    await withService(async (api) => {
      // Turned on before the app ever connected.
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);

      const note = api.networkCaptureAfterLaunch(APP);
      // Dialed once the wait is under way, as a freshly launched process does.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const app = await connectApp(api.socketPath);

      await expect(note).resolves.toBe(ARMED_NOTE);
      expect(askedToEnable(app)).toBe(true);
      app.close();
    });
  });

  /**
   * Every arm, pid read and close of the service wakes the waits still
   * registered with it, so a wait kept after it ended would be held and run
   * again for the life of the service, one more for each launch.
   */
  it("keeps nothing of its wait once the launched process is armed", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    await withService(async (api) => {
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);

      // The wait's timer, held weakly, tells whether anything still holds the wait.
      const waitTimers: Array<WeakRef<object>> = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((...args: Parameters<typeof realSetTimeout>) => {
        const timer = realSetTimeout(...args);
        if (args[1] === LAUNCH_ARM_WAIT_MS) waitTimers.push(new WeakRef(timer));
        return timer;
      }) as typeof setTimeout;
      let note: Promise<string | undefined>;
      try {
        note = api.networkCaptureAfterLaunch(APP);
        // Only the wait starts a timer before the app dials.
        const deadline = performance.now() + 2_000;
        while (waitTimers.length === 0 && performance.now() < deadline) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(waitTimers).toHaveLength(1);

      const app = await connectApp(api.socketPath);
      await expect(note).resolves.toBe(ARMED_NOTE);

      // A WeakRef keeps its target alive until the current job ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
      expect(waitTimers[0]!.deref()).toBeUndefined();
      app.close();
    });
  });

  /**
   * A launch also watches for a close of the app's connection, to ask the host
   * whether its process exited. A watch kept after the launch ended would ask
   * again at each later close, once more for each launch.
   */
  it("asks the host nothing at a later close for launches that already ended", async () => {
    await withService(async (api) => {
      const app = await dial(api);
      await api.startNetworkCapture(APP, METRO_PORT);
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      for (let launch = 0; launch < 3; launch++) {
        await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBe(ARMED_NOTE);
      }

      const probes = probeCalls().length;
      app.close();
      await vi.waitFor(() => expect(api.isConnected(APP)).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(probeCalls().length).toBe(probes);
    });
  });

  it("says the new process has not connected yet after waiting 5 s for it", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture(APP, METRO_PORT);

      const note = await afterTheLaunchWait(() => api.networkCaptureAfterLaunch(APP));

      expect(note).toBe(NOT_CONNECTED_NOTE);
    });
  });

  /**
   * launch-app only brings a running app to the front, so a process started
   * without the injection stays the app's process and never connects.
   */
  it("says at once, without waiting, that a running process without the injection cannot be armed", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture(APP, METRO_PORT);
      sim.psOutput = psLine("10:00", { injected: false });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const note = await api.networkCaptureAfterLaunch(APP);

      expect(note).toBe(
        `native network capture is on for ${APP}, but its running process (pid ${PID}) was launched without argent's injection for this simulator, so capture cannot be armed in it; call restart-app to start a process that is armed, then network-capture-start again, since a relaunch ends the JS layer's capture`
      );
    });
  });

  /**
   * A process that started before this service's listener dialed one that is
   * gone, as after a tool-server restart, and never dials again.
   */
  it("says at once, without waiting, that a running process older than the listener cannot be armed", async () => {
    await withService(async (api) => {
      await api.startNetworkCapture(APP, METRO_PORT);
      sim.psOutput = psLine("10:00");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const note = await api.networkCaptureAfterLaunch(APP);

      expect(note).toBe(
        `native network capture is on for ${APP}, but its running process (pid ${PID}) started before this tool-server's native-devtools listener, so it never connects and capture cannot be armed in it; call restart-app to start a process that is armed, then network-capture-start again, since a relaunch ends the JS layer's capture`
      );
    });
  });

  it("answers nothing, at once, when the service is disposed while it waits for the app", async () => {
    await withService(async (api, dispose) => {
      await api.startNetworkCapture(APP, METRO_PORT);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const note = api.networkCaptureAfterLaunch(APP);
      await launchWaitStarted();

      // As stop-all-simulator-servers does when it lands mid-launch.
      await dispose();

      // The fake clock never reaches the 5 s, so only the dispose can end the wait.
      const settled = await Promise.race([
        note.then((value) => ({ note: value })),
        new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
      ]);
      expect(settled).toEqual({ note: undefined });
    });
  });

  /**
   * stop-all-simulator-servers can also land while the host reads the launched
   * process, before the wait starts. Capture has ended then, so no note fits.
   */
  it.each([
    ["no process of the app runs", () => (sim.launchctlList = "")],
    [
      "its running process lacks the injection",
      () => (sim.psOutput = psLine("10:00", { injected: false })),
    ],
    ["its new process has not connected yet", () => {}],
  ])(
    "answers nothing, at once, when the service is disposed while the host reads the launch and %s",
    async (_case, arrange) => {
      await withService(async (api, dispose) => {
        await api.startNetworkCapture(APP, METRO_PORT);
        arrange();
        let readLaunch!: () => void;
        sim.launchctlHeld = new Promise((resolve) => (readLaunch = resolve));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const probes = probeCalls().length;
        const note = api.networkCaptureAfterLaunch(APP);
        await vi.waitFor(() => expect(probeCalls().length).toBeGreaterThan(probes));

        await dispose();
        readLaunch();

        // The fake clock never reaches the 5 s, so only the dispose can end the wait.
        const deadline = performance.now() + 2_000;
        let settled: unknown = "still waiting";
        void note.then((value) => (settled = { note: value }));
        while (settled === "still waiting" && performance.now() < deadline) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(settled).toEqual({ note: undefined });
      });
    }
  );

  /**
   * A new process can acknowledge Network.enable before the host has read its
   * pid. Until that read lands, the wait cannot tell the connection is the
   * launch's, so the read itself has to end the wait.
   */
  it("says capture is armed once the host reads the pid of a process that acknowledged first", async () => {
    await withService(async (api) => {
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const note = api.networkCaptureAfterLaunch(APP);
      await launchWaitStarted();
      let readPid!: () => void;
      sim.psHeld = new Promise((resolve) => (readPid = resolve));
      const settled = () =>
        Promise.race([
          note.then((value) => ({ note: value })),
          new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
        ]);

      const app = await connectApp(api.socketPath);
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state()).toEqual({ armed: true }));
      expect(await settled()).toBe("still waiting");
      readPid();

      // The fake clock never reaches the 5 s, so only the pid read can end the wait.
      expect(await settled()).toEqual({ note: ARMED_NOTE });
      app.close();
    });
  });

  it("does not count the armed connection of the process the launch replaced", async () => {
    await withService(async (api) => {
      const previous = await dial(api);
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(true);
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      // The launch started a new process, which has not dialed yet.
      sim.launchctlList = runningRow(PID + 1);

      const note = await afterTheLaunchWait(() => api.networkCaptureAfterLaunch(APP));

      expect(note).toBe(NOT_CONNECTED_NOTE);
      previous.close();
    });
  });

  it("says the new process has not acknowledged Network.enable after waiting 5 s", async () => {
    await withService(async (api) => {
      const app = await dial(api, { acknowledge: false });
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      void api.startNetworkCapture(APP, METRO_PORT);
      await vi.waitFor(() => expect(askedToEnable(app)).toBe(true));

      const note = await afterTheLaunchWait(() => api.networkCaptureAfterLaunch(APP));

      expect(note).toBe(
        `native network capture is on for ${APP}, and its new process (pid ${PID}) has not acknowledged Network.enable yet; native-network-logs shows when it is armed`
      );
      app.close();
    });
  });

  it("still reports an armed app when the simulator cannot list its running apps", async () => {
    await withService(async (api) => {
      const app = await dial(api);
      await api.startNetworkCapture(APP, METRO_PORT);
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      sim.launchctlFails = true;

      const settled = await api.networkCaptureAfterLaunch(APP).then(
        (note) => ({ note }),
        (err: unknown) => ({ err })
      );

      expect(settled).toEqual({
        note: ARMED_NOTE,
      });
      app.close();
    });
  });

  it("asks a connected process again whose Network.enable got no answer, and says why it is not armed", async () => {
    await withService(async (api) => {
      const app = await dial(api, { acknowledge: false });
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const first = api.startNetworkCapture(APP, METRO_PORT);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toBe(false);
      vi.useRealTimers();
      await vi.waitFor(() => expect(enableRequests(app)).toBe(1));

      const note = await afterTheLaunchWait(() => api.networkCaptureAfterLaunch(APP));

      expect(note).toBe(
        `native network capture is on for ${APP}, but its process (pid ${PID}) is not armed: the agent did not acknowledge Network.enable within 5 s; network-capture-start asks again`
      );
      expect(enableRequests(app)).toBe(2);
      app.close();
    });
  });

  it("says at once why a new process that refused Network.enable is not armed", async () => {
    await withService(async (api) => {
      await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const note = api.networkCaptureAfterLaunch(APP);
      await launchWaitStarted();

      const app = await connectApp(api.socketPath, { refuse: "capture unavailable" });

      // The fake clock never reaches the 5 s, so only the refusal can end the wait.
      const deadline = performance.now() + 2_000;
      let settled: unknown = "still waiting";
      void note.then((value) => (settled = { note: value }));
      while (settled === "still waiting" && performance.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(settled).toEqual({
        note: `native network capture is on for ${APP}, but its process (pid ${PID}) is not armed: the agent did not enable capture (native-devtools ${APP}: Network.enable failed: capture unavailable); network-capture-start asks again`,
      });
      app.close();
    });
  });

  describe("when no process of the app runs after the launch", () => {
    const GONE_NOTE = `native network capture is on for ${APP}, but no process of it is running after the launch; its next process is armed when it connects`;

    /** Resolves to the note once it settles, or to "still waiting" after `ms` of real time. */
    async function settledWithin(note: Promise<string | undefined>, ms: number) {
      const deadline = performance.now() + ms;
      let settled: unknown = "still waiting";
      void note.then((value) => (settled = { note: value }));
      while (settled === "still waiting" && performance.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    }

    it("says so at once when the launched process already exited", async () => {
      await withService(async (api) => {
        await api.startNetworkCapture(APP, METRO_PORT);
        // The app crashed at start: the simulator lists no process of it.
        sim.launchctlList = "";
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        // The fake clock never reaches the 5 s, so only the probe can end the wait.
        expect(await settledWithin(api.networkCaptureAfterLaunch(APP), 2_000)).toEqual({
          note: GONE_NOTE,
        });
      });
    });

    it("says so once the launched process closes its connection and exits before it is armed", async () => {
      await withService(async (api) => {
        await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
        const app = await dial(api, { acknowledge: false });
        await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const note = api.networkCaptureAfterLaunch(APP);
        await launchWaitStarted();
        expect(await settledWithin(note, 50)).toBe("still waiting");

        // The app crashes: its connection closes and the simulator lists no process of it.
        sim.launchctlList = "";
        app.close();

        expect(await settledWithin(note, 2_000)).toEqual({ note: GONE_NOTE });
      });
    });

    it("says so when the launched process exits while the host reads its pid", async () => {
      await withService(async (api) => {
        await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const note = api.networkCaptureAfterLaunch(APP);
        await launchWaitStarted();
        let readPid!: () => void;
        sim.psHeld = new Promise((resolve) => (readPid = resolve));

        // The new process connects and acknowledges, then crashes before the pid read ends.
        const app = await connectApp(api.socketPath);
        await vi.waitFor(() => expect(api.networkRecords(APP)?.state()).toEqual({ armed: true }));
        sim.launchctlList = "";
        app.close();
        await vi.waitFor(() => expect(api.isConnected(APP)).toBe(false));
        readPid();

        expect(await settledWithin(note, 2_000)).toEqual({ note: GONE_NOTE });
      });
    });

    it("says so when the launched process exits while the host reads the launch", async () => {
      await withService(async (api) => {
        await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
        const app = await dial(api, { acknowledge: false });
        await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
        let readLaunch!: () => void;
        sim.psHeld = new Promise((resolve) => (readLaunch = resolve));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const probes = probeCalls().length;
        const note = api.networkCaptureAfterLaunch(APP);
        await vi.waitFor(() => expect(probeCalls().length).toBeGreaterThan(probes));

        // The app crashes while the host reads the launched process.
        sim.launchctlList = "";
        app.close();
        await vi.waitFor(() => expect(api.isConnected(APP)).toBe(false));
        readLaunch();

        expect(await settledWithin(note, 2_000)).toEqual({ note: GONE_NOTE });
      });
    });

    it("keeps waiting when a connection closes but the launched process still runs", async () => {
      await withService(async (api) => {
        await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
        const app = await dial(api, { acknowledge: false });
        await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));

        const pending = afterTheLaunchWait(async () => {
          const result = api.networkCaptureAfterLaunch(APP);
          await launchWaitStarted();
          app.close();
          return result;
        });

        await expect(pending).resolves.toBe(NOT_CONNECTED_NOTE);
      });
    });

    /**
     * The host check after a close runs without a caller to catch its errors.
     * A failed check is no answer: the wait goes on, and no unhandled
     * rejection stops the tool-server.
     */
    it("keeps waiting when a connection closes and the host cannot list the running apps", async () => {
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", record);
      try {
        await withService(async (api) => {
          await expect(api.startNetworkCapture(APP, METRO_PORT)).resolves.toBe(false);
          const app = await dial(api, { acknowledge: false });
          await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));

          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const note = api.networkCaptureAfterLaunch(APP);
          await launchWaitStarted();

          // As when the simulator stops answering during the launch.
          sim.launchctlFails = true;
          const probes = probeCalls().length;
          app.close();
          const deadline = performance.now() + 2_000;
          while (probeCalls().length === probes && performance.now() < deadline) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          expect(probeCalls().length).toBeGreaterThan(probes);

          expect(await settledWithin(note, 50)).toBe("still waiting");
          await vi.advanceTimersByTimeAsync(LAUNCH_ARM_WAIT_MS);
          await expect(note).resolves.toBe(NOT_CONNECTED_NOTE);
        });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", record);
      }
    });
  });
});
