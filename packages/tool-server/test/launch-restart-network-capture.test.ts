import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

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
        if (sim.launchctlFails) {
          callback(new Error("Invalid device: the simulator did not answer"), {
            stdout: "",
            stderr: "",
          });
          return;
        }
        callback(null, { stdout: sim.launchctlList, stderr: "" });
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
});

const IOS_UDID = processScopedUdid("-4E7C-4A1B-9F3D-0C5A8B2E6D41");
const APP = "com.example.networktest";
const PID = 4242;
const ARMED_NOTE = `native network capture is armed for ${APP} (pid ${PID}); stop-all-simulator-servers for this device, then restart-app, ends it`;
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
 */
function connectApp(
  socketPath: string,
  { acknowledge = true }: { acknowledge?: boolean } = {}
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
          sock.write(
            JSON.stringify({ type: "CDP", payload: { id: frame.payload.id, result: {} } }) + "\n"
          );
        }
      }
    });
  });
}

/** Connects the fake app and waits until the service has taken its handshake. */
async function dial(api: NativeDevtoolsApi, options?: { acknowledge?: boolean }) {
  const app = await connectApp(api.socketPath, options);
  await vi.waitFor(() => expect(api.isConnected(APP)).toBe(true));
  return app;
}

const askedToEnable = (app: FakeApp): boolean =>
  app.received.some((frame) => frame.type === "CDP" && frame.payload?.method === "Network.enable");

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
    activateNetworkInspection: async () => false,
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
        await expect(api.activateNetworkInspection(APP)).resolves.toBe(false);
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

    it("still launches when the simulator cannot say which process was launched", async () => {
      await withService(async (api) => {
        await api.activateNetworkInspection(APP);
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
          networkCapture: `native network capture is armed for ${APP}; stop-all-simulator-servers for this device, then restart-app, ends it`,
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

  it("answers nothing for an app other than the one capture is on for", async () => {
    await withService(async (api) => {
      await api.activateNetworkInspection("com.example.other");

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBeUndefined();
    });
  });

  it("says capture is armed, with the pid, for a connected process that acknowledged", async () => {
    await withService(async (api) => {
      const app = await dial(api);
      await expect(api.activateNetworkInspection(APP)).resolves.toBe(true);

      await expect(api.networkCaptureAfterLaunch(APP)).resolves.toBe(ARMED_NOTE);
      expect(askedToEnable(app)).toBe(true);
      app.close();
    });
  });

  it("says capture is armed for a process that connects only after the launch", async () => {
    await withService(async (api) => {
      // Turned on before the app ever connected.
      await expect(api.activateNetworkInspection(APP)).resolves.toBe(false);

      const note = api.networkCaptureAfterLaunch(APP);
      // Dialed once the wait is under way, as a freshly launched process does.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const app = await connectApp(api.socketPath);

      await expect(note).resolves.toBe(ARMED_NOTE);
      expect(askedToEnable(app)).toBe(true);
      app.close();
    });
  });

  it("says the new process has not connected yet after waiting 5 s for it", async () => {
    await withService(async (api) => {
      await api.activateNetworkInspection(APP);

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
      await api.activateNetworkInspection(APP);
      sim.psOutput = psLine("10:00", { injected: false });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const note = await api.networkCaptureAfterLaunch(APP);

      expect(note).toBe(
        `native network capture is on for ${APP}, but its running process (pid ${PID}) was launched without argent's injection for this simulator, so capture cannot be armed in it; call restart-app to start a process that is armed`
      );
    });
  });

  /**
   * A process that started before this service's listener dialed one that is
   * gone, as after a tool-server restart, and never dials again.
   */
  it("says at once, without waiting, that a running process older than the listener cannot be armed", async () => {
    await withService(async (api) => {
      await api.activateNetworkInspection(APP);
      sim.psOutput = psLine("10:00");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const note = await api.networkCaptureAfterLaunch(APP);

      expect(note).toBe(
        `native network capture is on for ${APP}, but its running process (pid ${PID}) started before this tool-server's native-devtools listener, so it never connects and capture cannot be armed in it; call restart-app to start a process that is armed`
      );
    });
  });

  it("answers nothing, at once, when the service is disposed while it waits for the app", async () => {
    await withService(async (api, dispose) => {
      await api.activateNetworkInspection(APP);
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
   * A new process can acknowledge Network.enable before the host has read its
   * pid. Until that read lands, the wait cannot tell the connection is the
   * launch's, so the read itself has to end the wait.
   */
  it("says capture is armed once the host reads the pid of a process that acknowledged first", async () => {
    await withService(async (api) => {
      await expect(api.activateNetworkInspection(APP)).resolves.toBe(false);
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
      await expect(api.activateNetworkInspection(APP)).resolves.toBe(true);
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
      void api.activateNetworkInspection(APP);
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
      await api.activateNetworkInspection(APP);
      await vi.waitFor(() => expect(api.networkRecords(APP)?.state().pid).toBe(PID));
      sim.launchctlFails = true;

      const settled = await api.networkCaptureAfterLaunch(APP).then(
        (note) => ({ note }),
        (err: unknown) => ({ err })
      );

      expect(settled).toEqual({
        note: `native network capture is armed for ${APP} (pid ${PID}); stop-all-simulator-servers for this device, then restart-app, ends it`,
      });
      app.close();
    });
  });
});
