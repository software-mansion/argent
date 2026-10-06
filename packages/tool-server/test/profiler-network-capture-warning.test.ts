import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(warning).toContain("native-network-logs with stop: true for that app, then restart-app");
  });

  it("names every app when several have live capture", () => {
    live.mockReturnValue([PKG, "com.example.other"]);

    const warning = nativeNetworkCaptureWarning(SERIAL);

    expect(warning).toContain(`on for ${PKG}, com.example.other on this device`);
    expect(warning).toContain("to the processes of these apps");
    expect(warning).toContain("for each of these apps");
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
        `native-network-logs with stop: true for ${PKG} on each of those devices, then restart-app`
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

describe("native-profiler-start", () => {
  function session(platform: "ios" | "android"): NativeProfilerSessionApi {
    return { platform } as NativeProfilerSessionApi;
  }

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

  it("does not look for Android capture on iOS", async () => {
    live.mockReturnValue([PKG]);

    const result = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
      device_id: IOS_UDID,
    });

    expect(live).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("warning");
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
        `native-network-logs with stop: true for ${PKG} on that device, then restart-app`
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
