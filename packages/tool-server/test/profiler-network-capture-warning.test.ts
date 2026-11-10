import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

// Which apps have live native network capture, per device id asked about.
const live = vi.fn<(deviceId: string) => string[]>();
// Which devices have live native network capture, per app asked about.
const liveDevices = vi.fn<(packageName: string) => string[]>();
vi.mock("../src/blueprints/android-network-inspector", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/android-network-inspector")>()),
  liveAndroidNetworkCaptures: (deviceId: string) => live(deviceId),
  liveAndroidNetworkCaptureDevices: (packageName: string) => liveDevices(packageName),
}));

// The same two lookups for iOS apps.
const liveIos = vi.fn<(deviceId: string) => string[]>();
const liveIosDevices = vi.fn<(bundleId: string) => string[]>();
vi.mock("../src/blueprints/ios-network-records", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/ios-network-records")>()),
  liveIosNetworkCaptures: (deviceId: string) => liveIos(deviceId),
  liveIosNetworkCaptureDevices: (bundleId: string) => liveIosDevices(bundleId),
}));

// The real services the "after a stop" cases run reach no device: every adb
// call fails as on a device that went offline, and every simctl call succeeds.
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  const offline = async () => {
    throw new Error("adb: device offline");
  };
  return {
    ...actual,
    adbShell: vi.fn(offline),
    adbShellInput: vi.fn(offline),
    runAdb: vi.fn(offline),
    adbReverse: vi.fn(offline),
    removeAdbReverse: vi.fn(offline),
  };
});
type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (_cmd: string, args: readonly string[], opts: unknown, cb?: ExecCb) => {
      const callback = (typeof opts === "function" ? opts : cb!) as ExecCb;
      const stdout = args.join(" ").includes("simctl list") ? JSON.stringify({ devices: {} }) : "";
      callback(null, { stdout, stderr: "" });
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

vi.mock("../src/utils/check-deps", () => ({
  ensureDeps: vi.fn(async () => {}),
  ensureDep: vi.fn(async () => {}),
}));
vi.mock("../src/tools/profiler/native-profiler/platforms/android", () => ({
  startNativeProfilerAndroid: vi.fn(async () => ({
    status: "recording",
    pid: 2,
    traceFile: "/android.pftrace",
  })),
}));
vi.mock("../src/tools/profiler/native-profiler/platforms/ios", () => ({
  startNativeProfilerIos: vi.fn(async () => ({
    status: "recording",
    pid: 1,
    traceFile: "/ios.trace",
  })),
  handleXctraceExit: vi.fn(),
}));

import { nativeNetworkCaptureWarning } from "../src/utils/profiler-shared/network-capture-warning";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { createReactProfilerStartTool } from "../src/tools/profiler/react/react-profiler-start";
import {
  READ_STATE_SCRIPT,
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
} from "../src/utils/react-profiler/scripts";
import type { NativeProfilerSessionApi } from "../src/blueprints/native-profiler-session";
import type { RuntimeAppMetadata } from "../src/blueprints/js-runtime-debugger";
import { rememberLogicalKeyedDevice, resetDeviceAliases } from "../src/utils/debugger/device-alias";
import {
  androidNetworkInspectorBlueprint,
  androidNetworkInspectorRef,
} from "../src/blueprints/android-network-inspector";
import { nativeDevtoolsBlueprint, type NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { resolveDevice } from "../src/utils/device-info";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const SERIAL = "emulator-5554";
const IOS_UDID = "11111111-2222-3333-4444-555555555555";
const PKG = "com.example.networktest";
const OTHER_PKG = "com.example.other";
/** A Metro logicalDeviceId: what device_id is once two devices share one Metro. */
const LOGICAL = "a".repeat(64);
const ANDROID_APP: RuntimeAppMetadata = { appId: PKG, platform: "android" };

beforeEach(() => {
  live.mockReset();
  live.mockReturnValue([]);
  liveDevices.mockReset();
  liveDevices.mockReturnValue([]);
  liveIos.mockReset();
  liveIos.mockReturnValue([]);
  liveIosDevices.mockReset();
  liveIosDevices.mockReturnValue([]);
  resetDeviceAliases();
});

/** Capture is on for `apps` on SERIAL only, looked up the way the inspector keys it. */
function captureOnSerial(...apps: string[]): void {
  live.mockImplementation((deviceId) => (deviceId === SERIAL ? apps : []));
  liveDevices.mockImplementation((packageName) => (apps.includes(packageName) ? [SERIAL] : []));
}

/** What connecting the debugger with a logicalDeviceId records. */
function connectedWithLogicalId(): void {
  rememberLogicalKeyedDevice(LOGICAL, LOGICAL);
}

describe("nativeNetworkCaptureWarning", () => {
  it("is undefined when no app on the device has live capture", () => {
    expect(nativeNetworkCaptureWarning(SERIAL)).toBeUndefined();
    expect(live).toHaveBeenCalledWith(SERIAL);
  });

  it("names the app, says capture can change timings, and says how to end it", () => {
    live.mockReturnValue([PKG]);

    const warning = nativeNetworkCaptureWarning(SERIAL);

    expect(warning).toContain(`Native network capture is on for ${PKG} on this device`);
    expect(warning).toContain("Argent attaches its in-app agent to the processes of that app");
    expect(warning).toContain("can slow the app");
    expect(warning).toContain("timings");
    expect(warning).toContain(
      "stop this profile, call network-capture-stop for that app, then restart-app and profile again"
    );
  });

  it("names every app when several have live capture", () => {
    live.mockReturnValue([PKG, "com.example.other"]);

    const warning = nativeNetworkCaptureWarning(SERIAL);

    expect(warning).toContain(`on for ${PKG}, com.example.other on this device`);
    expect(warning).toContain("to the processes of these apps");
    expect(warning).toContain("call network-capture-stop for each of these apps");
  });

  it("names an iOS app with the remedy that ends capture there", () => {
    liveIos.mockImplementation((deviceId) => (deviceId === IOS_UDID ? [PKG] : []));

    const warning = nativeNetworkCaptureWarning(IOS_UDID);

    expect(warning).toContain(`Native network capture is on for ${PKG} on this device`);
    expect(warning).toContain(
      "Argent's in-app agent captures the requests of that app's processes"
    );
    expect(warning).toContain("can slow the app");
    expect(warning).toContain(
      "stop this profile, call network-capture-stop for that app, then restart-app and profile again"
    );
    expect(warning).not.toContain("stop-all-simulator-servers");
  });

  it("is undefined, not a throw, when the lookup fails", () => {
    live.mockImplementation(() => {
      throw new Error("lookup failed");
    });

    expect(nativeNetworkCaptureWarning(SERIAL)).toBeUndefined();
  });

  describe("for a device_id that is a Metro logicalDeviceId", () => {
    it("names the devices with capture on for the profiled app, since the id names none", () => {
      connectedWithLogicalId();
      liveDevices.mockImplementation((packageName) =>
        packageName === PKG ? [SERIAL, "emulator-5556"] : []
      );

      const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP);

      expect(liveDevices).toHaveBeenCalledWith(PKG);
      expect(warning).toContain(
        `Native network capture is on for ${PKG} on ${SERIAL}, emulator-5556, one of which may be the device this profile runs on`
      );
      expect(warning).toContain("logicalDeviceId");
      expect(warning).toContain("can slow the app");
      expect(warning).toContain(
        `call network-capture-stop for ${PKG} on each of those devices, then restart-app`
      );
    });

    it("is undefined when capture is on only for other apps", () => {
      connectedWithLogicalId();
      captureOnSerial(OTHER_PKG);

      expect(nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP)).toBeUndefined();
    });

    it("is undefined for an iOS runtime, even when an Android device captures the same app id", () => {
      connectedWithLogicalId();
      captureOnSerial(PKG);

      expect(nativeNetworkCaptureWarning(LOGICAL, { appId: PKG, platform: "ios" })).toBeUndefined();
    });

    it("names the simulators with capture on for an iOS runtime's app", () => {
      connectedWithLogicalId();
      liveIosDevices.mockImplementation((bundleId) => (bundleId === PKG ? [IOS_UDID] : []));

      const warning = nativeNetworkCaptureWarning(LOGICAL, { appId: PKG, platform: "ios" });

      expect(liveIosDevices).toHaveBeenCalledWith(PKG);
      expect(liveDevices).not.toHaveBeenCalled();
      expect(warning).toContain(
        `Native network capture is on for ${PKG} on ${IOS_UDID}, which may be the device this profile runs on`
      );
      expect(warning).toContain("captures the requests of that app's processes there");
      expect(warning).toContain(
        `call network-capture-stop for ${PKG} on that device, then restart-app and profile again`
      );
    });

    it("is undefined for an Android runtime when only an iOS simulator captures the app id", () => {
      connectedWithLogicalId();
      liveIosDevices.mockReturnValue([IOS_UDID]);

      expect(nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP)).toBeUndefined();
    });

    it("is undefined when the runtime did not say its app or platform", () => {
      connectedWithLogicalId();
      captureOnSerial(PKG);

      expect(nativeNetworkCaptureWarning(LOGICAL)).toBeUndefined();
      expect(nativeNetworkCaptureWarning(LOGICAL, { platform: "android" })).toBeUndefined();
      expect(nativeNetworkCaptureWarning(LOGICAL, { appId: PKG })).toBeUndefined();
    });
  });

  it("does not look at other devices for a device_id that names a device", () => {
    // Profiling the app on emulator-5556 while capture is on for it on SERIAL.
    captureOnSerial(PKG);

    expect(nativeNetworkCaptureWarning("emulator-5556", ANDROID_APP)).toBeUndefined();
    expect(liveDevices).not.toHaveBeenCalled();
  });
});

/** Dials the native-devtools service as the app's agent does, and acknowledges each request. */
function connectApp(socketPath: string): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const sock = net.createConnection(socketPath, () => {
      sock.write(JSON.stringify({ type: "Control", payload: { bundleId: PKG } }) + "\n");
      resolve({ close: () => sock.destroy() });
    });
    sock.once("error", reject);
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const frame = JSON.parse(line) as { type?: string; payload?: { id?: number } };
        if (frame.type === "CDP" && frame.payload?.id !== undefined) {
          sock.write(
            JSON.stringify({ type: "CDP", payload: { id: frame.payload.id, result: {} } }) + "\n"
          );
        }
      }
    });
  });
}

describe("native-profiler-start", () => {
  function session(platform: "ios" | "android"): NativeProfilerSessionApi {
    return { platform } as NativeProfilerSessionApi;
  }

  describe("after network-capture-stop, with the real capture services", () => {
    it("warns on Android while capture is started, and not once it is stopped", async () => {
      const actual = await vi.importActual<
        typeof import("../src/blueprints/android-network-inspector")
      >("../src/blueprints/android-network-inspector");
      live.mockImplementation(actual.liveAndroidNetworkCaptures);
      liveDevices.mockImplementation(actual.liveAndroidNetworkCaptureDevices);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      // The agent's binaries are gitignored build output, so stand in for them.
      const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-profiler-network-"));
      for (const file of [
        "network-inspector.jar",
        "x86_64/libjvmti_network_inspector.so",
        "arm64-v8a/libjvmti_network_inspector.so",
      ]) {
        const at = path.join(binRoot, "network-inspector", file);
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.writeFileSync(at, file);
      }
      vi.stubEnv("ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR", binRoot);
      const ref = androidNetworkInspectorRef(resolveDevice(SERIAL), PKG, 8081);
      const inspector = await androidNetworkInspectorBlueprint.factory(
        {},
        ref.urn.slice(ref.urn.indexOf(":") + 1),
        ref.options
      );
      try {
        // adb did not answer, so capture is started and the next launch attaches.
        await expect(inspector.api.startCapture(8081)).resolves.toMatchObject({ armed: false });
        expect(inspector.api.isStarted()).toBe(true);
        const during = await nativeProfilerStartTool.execute(
          { session: session("android") } as never,
          { device_id: SERIAL }
        );
        expect(during.warning).toContain(`Native network capture is on for ${PKG}`);

        await inspector.api.stopCapture();
        const after = await nativeProfilerStartTool.execute(
          { session: session("android") } as never,
          { device_id: SERIAL }
        );

        expect(after).toEqual({ status: "recording", pid: 2, traceFile: "/android.pftrace" });
        connectedWithLogicalId();
        expect(nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP)).toBeUndefined();
      } finally {
        await inspector.dispose();
        stderr.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(binRoot, { recursive: true, force: true });
      }
    });

    it("warns on iOS while capture is started, and not once it is stopped", async () => {
      const actual = await vi.importActual<typeof import("../src/blueprints/ios-network-records")>(
        "../src/blueprints/ios-network-records"
      );
      liveIos.mockImplementation(actual.liveIosNetworkCaptures);
      liveIosDevices.mockImplementation(actual.liveIosNetworkCaptureDevices);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const udid = processScopedUdid("-2222-3333-4444-555555555555");
      const device = resolveDevice(udid);
      const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
      const api = instance.api as NativeDevtoolsApi;
      try {
        const app = await connectApp(api.socketPath);
        await vi.waitFor(() => expect(api.isConnected(PKG)).toBe(true));
        await expect(api.startNetworkCapture(PKG, 8081)).resolves.toBe(true);
        const during = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
          device_id: udid,
        });
        expect(during.warning).toContain(`Native network capture is on for ${PKG}`);

        await expect(api.stopNetworkCapture(PKG)).resolves.toEqual({ confirmed: true });
        const after = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
          device_id: udid,
        });

        expect(after).toEqual({ status: "recording", pid: 1, traceFile: "/ios.trace" });
        connectedWithLogicalId();
        expect(
          nativeNetworkCaptureWarning(LOGICAL, { appId: PKG, platform: "ios" })
        ).toBeUndefined();
        app.close();
      } finally {
        await instance.dispose();
        stderr.mockRestore();
      }
    });
  });

  it("warns on Android when native network capture is live", async () => {
    live.mockReturnValue([PKG]);

    const result = await nativeProfilerStartTool.execute({ session: session("android") } as never, {
      device_id: SERIAL,
    });

    expect(live).toHaveBeenCalledWith(SERIAL);
    expect(result).toMatchObject({ status: "recording", pid: 2 });
    expect(result.warning).toContain(`Native network capture is on for ${PKG}`);
  });

  it("adds no warning on Android when no capture is live", async () => {
    const result = await nativeProfilerStartTool.execute({ session: session("android") } as never, {
      device_id: SERIAL,
    });

    expect(result).toEqual({ status: "recording", pid: 2, traceFile: "/android.pftrace" });
  });

  it("warns on iOS when native network capture is on for an app of the simulator", async () => {
    liveIos.mockImplementation((deviceId) => (deviceId === IOS_UDID ? [PKG] : []));

    const result = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
      device_id: IOS_UDID,
    });

    expect(result).toMatchObject({ status: "recording", pid: 1 });
    expect(result.warning).toContain(`Native network capture is on for ${PKG}`);
    expect(result.warning).toContain("call network-capture-stop for that app");
  });

  it("adds no warning on iOS when no capture is on", async () => {
    const result = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
      device_id: IOS_UDID,
    });

    expect(result).toEqual({ status: "recording", pid: 1, traceFile: "/ios.trace" });
  });
});

describe("react-profiler-start", () => {
  /** A registry whose React profiler session starts cleanly on the first try. */
  function registryWithRuntime(
    deviceId = SERIAL,
    runtimeApp: RuntimeAppMetadata | undefined = ANDROID_APP
  ): Registry {
    const cdp = {
      isConnected: () => true,
      evaluate: vi.fn(async (script: string) => {
        if (script === REACT_NATIVE_PROFILER_SETUP_SCRIPT) return undefined;
        if (script === READ_STATE_SCRIPT) {
          return JSON.stringify({
            hookExists: true,
            rendererInterfaceFound: true,
            isRunning: false,
            owner: null,
            nowEpochMs: 1_000,
          });
        }
        // The start script.
        return JSON.stringify({
          ok: true,
          startedAtEpochMs: 1_000,
          isProfilingFlagSet: true,
          ownerInstalled: true,
        });
      }),
      send: vi.fn(async () => ({})),
    };
    const api = {
      cdp,
      port: 8081,
      deviceId,
      hermesVersion: "0.12.0",
      detectedArchitecture: "bridgeless",
      profilingActive: false,
      runtimeApp,
    };
    return {
      getSnapshot: () => ({ services: new Map() }),
      resolveService: vi.fn(async () => api),
      getServiceState: () => null,
      disposeService: vi.fn(async () => {}),
    } as unknown as Registry;
  }

  it("warns when native network capture is live on the device", async () => {
    live.mockReturnValue([PKG]);

    const result = await createReactProfilerStartTool(registryWithRuntime()).execute(
      {},
      { device_id: SERIAL, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(live).toHaveBeenCalledWith(SERIAL);
    expect(result.started_at).toBe(new Date(1_000).toISOString());
    expect(result.warning).toContain(`Native network capture is on for ${PKG}`);
  });

  it("adds no warning when no capture is live", async () => {
    const result = await createReactProfilerStartTool(registryWithRuntime()).execute(
      {},
      { device_id: SERIAL, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(result.started_at).toBe(new Date(1_000).toISOString());
    expect(result).not.toHaveProperty("warning");
  });

  describe("with two devices on one Metro, connected by logicalDeviceId", () => {
    function start(runtimeApp: RuntimeAppMetadata | undefined) {
      connectedWithLogicalId();
      return createReactProfilerStartTool(registryWithRuntime(LOGICAL, runtimeApp)).execute(
        {},
        { device_id: LOGICAL, port: 8081, sample_interval_us: 100, force: false }
      );
    }

    it("warns when capture is on for the profiled app on an Android device", async () => {
      captureOnSerial(PKG);

      const result = await start(ANDROID_APP);

      expect(result.started_at).toBe(new Date(1_000).toISOString());
      expect(result.warning).toContain(
        `Native network capture is on for ${PKG} on ${SERIAL}, which may be the device this profile runs on`
      );
      expect(result.warning).toContain(
        `call network-capture-stop for ${PKG} on that device, then restart-app`
      );
    });

    it("adds no warning when capture is on only for another app", async () => {
      captureOnSerial(OTHER_PKG);

      const result = await start(ANDROID_APP);

      expect(result).not.toHaveProperty("warning");
    });

    it("adds no warning when the profiled runtime is on iOS", async () => {
      captureOnSerial(PKG);

      const result = await start({ appId: PKG, platform: "ios" });

      expect(result).not.toHaveProperty("warning");
    });
  });
});
