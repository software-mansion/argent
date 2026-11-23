import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";

// Which apps have live native network capture, per device id asked about.
const live = vi.fn<(deviceId: string) => string[]>();
// Which devices have live native network capture, per app asked about.
const liveDevices = vi.fn<(packageName: string) => string[]>();
// Which serials have live native network capture for any app.
const liveSerials = vi.fn<() => string[]>();
vi.mock("../src/blueprints/android-network-inspector", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/android-network-inspector")>()),
  liveAndroidNetworkCaptures: (deviceId: string) => live(deviceId),
  liveAndroidNetworkCaptureDevices: (packageName: string) => liveDevices(packageName),
  liveAndroidNetworkCaptureSerials: () => liveSerials(),
}));

type ProbeOptions = { awaitSerials?: readonly string[]; waitSerials?: readonly string[] };

// Where the profiled runtime is found, for a logicalDeviceId session.
const { NOT_FOUND, foundOn } = vi.hoisted(() => ({
  NOT_FOUND: { found: [] as string[], unresolved: [] as string[] },
  foundOn: (...found: string[]) => ({ found, unresolved: [] as string[] }),
}));
const findRuntimeDevices = vi.fn(
  async (_cdp: unknown, _opts?: ProbeOptions): Promise<RuntimeDevices> => NOT_FOUND
);
vi.mock("../src/utils/debugger/runtime-device", () => ({
  findRuntimeDevices: (cdp: unknown, opts?: ProbeOptions) => findRuntimeDevices(cdp, opts),
}));

// The same two lookups for iOS apps.
const liveIos = vi.fn<(deviceId: string) => string[]>();
const liveIosDevices = vi.fn<(bundleId: string) => string[]>();
vi.mock("../src/blueprints/ios-network-records", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/ios-network-records")>()),
  liveIosNetworkCaptures: (deviceId: string) => liveIos(deviceId),
  liveIosNetworkCaptureDevices: (bundleId: string) => liveIosDevices(bundleId),
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
import type { RuntimeDevices } from "../src/utils/debugger/runtime-device";
import { rememberLogicalKeyedDevice, resetDeviceAliases } from "../src/utils/debugger/device-alias";
import { registerCaptureOnDemandSender } from "../src/utils/profiling-devices";

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
  liveSerials.mockReset();
  liveSerials.mockReturnValue([]);
  findRuntimeDevices.mockReset();
  findRuntimeDevices.mockResolvedValue(NOT_FOUND);
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
      "stop this profile, call native-network-logs with stop: true for that app, then restart-app and profile again"
    );
  });

  it("names every app when several have live capture", () => {
    live.mockReturnValue([PKG, "com.example.other"]);

    const warning = nativeNetworkCaptureWarning(SERIAL);

    expect(warning).toContain(`on for ${PKG}, com.example.other on this device`);
    expect(warning).toContain("to the processes of these apps");
    expect(warning).toContain("native-network-logs with stop: true for each of these apps");
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
      "stop this profile, call stop-all-simulator-servers for this device, then restart-app and profile again"
    );
    expect(warning).not.toContain("stop: true");
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
        "call stop-all-simulator-servers for that device, then restart-app and profile again"
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

    it("checks only the device the runtime was found on, and names it", () => {
      connectedWithLogicalId();
      captureOnSerial(PKG, OTHER_PKG);

      const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, foundOn(SERIAL));

      expect(live).toHaveBeenCalledWith(SERIAL);
      expect(liveDevices).not.toHaveBeenCalled();
      expect(warning).toContain(
        `Native network capture is on for ${PKG}, ${OTHER_PKG} on ${SERIAL}, the device this profile runs on:`
      );
      expect(warning).toContain(
        `native-network-logs with udid ${SERIAL} and stop: true for each of these apps, then restart-app on ${SERIAL}`
      );
    });

    it("is undefined when capture is on for the app only on a device the runtime was not found on", () => {
      connectedWithLogicalId();
      captureOnSerial(PKG);

      expect(
        nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, foundOn("emulator-5556"))
      ).toBeUndefined();
      expect(liveDevices).not.toHaveBeenCalled();
    });

    describe("on a device found under two adb transports", () => {
      const USB = "R58M123ABC";
      const WIRELESS = "192.168.1.5:5555";

      it("finds capture kept under either serial, in either order, and names that serial", () => {
        connectedWithLogicalId();
        live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [PKG] : []));

        for (const devices of [
          [USB, WIRELESS],
          [WIRELESS, USB],
        ]) {
          const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, foundOn(...devices));

          expect(warning).toContain(
            `Native network capture is on for ${PKG} on ${WIRELESS}, the device this profile runs on:`
          );
          expect(warning).toContain(
            `call native-network-logs with udid ${WIRELESS} and stop: true for that app, then restart-app on ${WIRELESS}`
          );
        }
        expect(liveDevices).not.toHaveBeenCalled();
      });

      it("names each app with the serial its capture is under when both serials have some", () => {
        connectedWithLogicalId();
        live.mockImplementation((deviceId) =>
          deviceId === USB ? [OTHER_PKG] : deviceId === WIRELESS ? [PKG] : []
        );

        const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, foundOn(USB, WIRELESS));

        expect(warning).toContain(`${OTHER_PKG} with udid ${USB}`);
        expect(warning).toContain(`${PKG} with udid ${WIRELESS}`);
        expect(warning).toContain(`restart-app on ${USB}`);
      });

      // An emulator has no hardware key, so the same app can be captured under both serials.
      it("names an app captured under both serials once", () => {
        connectedWithLogicalId();
        live.mockImplementation((deviceId) =>
          deviceId === USB || deviceId === WIRELESS ? [PKG] : []
        );

        const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, foundOn(USB, WIRELESS));

        expect(warning).toContain(`${PKG} on ${USB} and ${WIRELESS}`);
        expect(warning).toContain(`${PKG} with udid ${USB}`);
        expect(warning).toContain(`${PKG} with udid ${WIRELESS}`);
      });

      describe("with a serial whose logcat could not be read", () => {
        const unresolvedOn = (found: string, ...unresolved: string[]) => ({
          found: [found],
          unresolved,
        });

        // Capture for another app there is not named, nor stopped: the serial
        // may be another device.
        it("names it as one that may also be the profiled device when capture is on for the app there", () => {
          connectedWithLogicalId();
          live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [OTHER_PKG, PKG] : []));

          const warning = nativeNetworkCaptureWarning(
            LOGICAL,
            ANDROID_APP,
            unresolvedOn(USB, WIRELESS)
          );

          expect(warning).toContain(`${PKG} on ${WIRELESS}, which may`);
          expect(warning).toContain(`${PKG} with udid ${WIRELESS}`);
          expect(warning).toContain(`restart-app on ${USB}`);
          expect(warning).not.toContain(OTHER_PKG);
          expect(liveDevices).not.toHaveBeenCalled();
        });

        it("names each of several such serials, and how to stop capture under each", () => {
          const OTHER_WIRELESS = "10.0.0.8:5555";
          connectedWithLogicalId();
          live.mockImplementation((deviceId) =>
            deviceId === WIRELESS || deviceId === OTHER_WIRELESS ? [PKG] : []
          );

          const warning = nativeNetworkCaptureWarning(
            LOGICAL,
            ANDROID_APP,
            unresolvedOn(USB, WIRELESS, OTHER_WIRELESS)
          );

          expect(warning).toContain(`${WIRELESS}, ${OTHER_WIRELESS}, each of which may`);
          expect(warning).toContain(`${PKG} with udid ${WIRELESS}`);
          expect(warning).toContain(`${PKG} with udid ${OTHER_WIRELESS}`);
          expect(warning).toContain(`restart-app on ${USB}`);
        });

        // Two sets of steps would have the agent stop the run it just restarted,
        // and could name two serials of one device to restart.
        it("names it in the found device's warning, with one set of steps", () => {
          const OTHER_DEVICE = "10.0.0.7:5555";
          connectedWithLogicalId();
          live.mockImplementation((deviceId) =>
            deviceId === WIRELESS ? [OTHER_PKG] : deviceId === OTHER_DEVICE ? [PKG] : []
          );

          const warning = nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, {
            found: [USB, WIRELESS],
            unresolved: [OTHER_DEVICE],
          });

          expect(warning).toContain(`${OTHER_PKG} on ${WIRELESS}`);
          expect(warning).toContain(`${PKG} on ${OTHER_DEVICE}, which may`);
          expect(warning).toContain(`${OTHER_PKG} with udid ${WIRELESS}`);
          expect(warning).toContain(`${PKG} with udid ${OTHER_DEVICE}`);
          expect(warning).toContain(`restart-app on ${WIRELESS}`);
          expect(warning?.match(/restart-app/g)).toHaveLength(1);
        });

        it("is undefined when capture there is only for other apps, or the runtime is not Android", () => {
          connectedWithLogicalId();
          live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [OTHER_PKG] : []));

          expect(
            nativeNetworkCaptureWarning(LOGICAL, ANDROID_APP, unresolvedOn(USB, WIRELESS))
          ).toBeUndefined();

          live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [PKG] : []));

          expect(
            nativeNetworkCaptureWarning(
              LOGICAL,
              { appId: PKG, platform: "ios" },
              unresolvedOn(USB, WIRELESS)
            )
          ).toBeUndefined();
          expect(
            nativeNetworkCaptureWarning(LOGICAL, undefined, unresolvedOn(USB, WIRELESS))
          ).toBeUndefined();
        });
      });
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

  it("warns on iOS when native network capture is on for an app of the simulator", async () => {
    liveIos.mockImplementation((deviceId) => (deviceId === IOS_UDID ? [PKG] : []));

    const result = await nativeProfilerStartTool.execute({ session: session("ios") } as never, {
      device_id: IOS_UDID,
    });

    expect(result).toMatchObject({ status: "recording", pid: 1 });
    expect(result.warning).toContain(`Native network capture is on for ${PKG}`);
    expect(result.warning).toContain("stop-all-simulator-servers");
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

  it("says the warning is for iOS and Android, as a Mac app's capture is never named", () => {
    // A Mac app's capture is kept by its own service, which neither lookup reads.
    expect(nativeNetworkCaptureWarning("macos-app-com.example.mac")).toBeUndefined();
    expect(createReactProfilerStartTool(registryWithRuntime()).description).toContain(
      "On iOS and Android, a warning names the apps with native network capture on"
    );
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

    describe("when the runtime's device is not found", () => {
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

      it("adds no warning for an iOS runtime when only an Android device captures the app id", async () => {
        captureOnSerial(PKG);

        const result = await start({ appId: PKG, platform: "ios" });

        expect(result).not.toHaveProperty("warning");
      });
    });

    describe("when the runtime's device is found", () => {
      const PROFILED_SERIAL = "emulator-5556";

      it("adds no warning when capture is on for the app only on another device", async () => {
        findRuntimeDevices.mockResolvedValue(foundOn(PROFILED_SERIAL));
        captureOnSerial(PKG);

        const result = await start(ANDROID_APP);

        expect(live).toHaveBeenCalledWith(PROFILED_SERIAL);
        expect(liveDevices).not.toHaveBeenCalled();
        expect(result).not.toHaveProperty("warning");
      });

      it("warns about that device alone, by its id, when capture is on there", async () => {
        findRuntimeDevices.mockResolvedValue(foundOn(SERIAL));
        captureOnSerial(PKG);

        const result = await start(ANDROID_APP);

        expect(result.warning).toContain(
          `Native network capture is on for ${PKG} on ${SERIAL}, the device this profile runs on:`
        );
        expect(result.warning).toContain(
          `call native-network-logs with udid ${SERIAL} and stop: true for that app, then restart-app on ${SERIAL} and profile again.`
        );
        expect(result.warning).not.toContain("logicalDeviceId");
      });

      it("checks the simulator, not Android devices by app, for an iOS runtime", async () => {
        findRuntimeDevices.mockResolvedValue(foundOn(IOS_UDID));
        captureOnSerial(PKG);

        const result = await start({ appId: PKG, platform: "ios" });

        expect(live).toHaveBeenCalledWith(IOS_UDID);
        expect(liveDevices).not.toHaveBeenCalled();
        expect(result).not.toHaveProperty("warning");
      });

      it("warns an iOS runtime when capture is on for its app on the simulator it runs on", async () => {
        findRuntimeDevices.mockResolvedValue(foundOn(IOS_UDID));
        liveIos.mockImplementation((deviceId) => (deviceId === IOS_UDID ? [PKG] : []));
        liveIosDevices.mockImplementation((bundleId) => (bundleId === PKG ? [IOS_UDID] : []));

        const result = await start({ appId: PKG, platform: "ios" });

        expect(result.started_at).toBe(new Date(1_000).toISOString());
        expect(result.warning).toContain(
          `Native network capture is on for ${PKG} on ${IOS_UDID}, the device this profile runs on:`
        );
        expect(result.warning).toContain("captures the requests of that app's processes");
        expect(result.warning).toContain(
          `call stop-all-simulator-servers for ${IOS_UDID}, then restart-app on ${IOS_UDID} and profile again.`
        );
        expect(result.warning).not.toContain("stop: true");
        expect(result.warning).not.toContain("logicalDeviceId");
      });

      it("warns when capture is kept under the device's other adb serial", async () => {
        const WIRELESS = "192.168.1.5:5555";
        findRuntimeDevices.mockResolvedValue(foundOn(SERIAL, WIRELESS));
        live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [PKG] : []));

        const result = await start(ANDROID_APP);

        expect(result.warning).toContain(
          `Native network capture is on for ${PKG} on ${WIRELESS}, the device this profile runs on:`
        );
      });

      it("asks the probe to wait in full for the serials capture is kept under", async () => {
        const WIRELESS = "192.168.1.5:5555";
        liveSerials.mockReturnValue([WIRELESS]);
        findRuntimeDevices.mockResolvedValue({ found: [SERIAL], unresolved: [WIRELESS] });
        live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [PKG] : []));

        const result = await start(ANDROID_APP);

        expect(findRuntimeDevices).toHaveBeenCalledWith(expect.anything(), {
          awaitSerials: [WIRELESS],
          waitSerials: [],
        });
        expect(result.warning).toContain(
          `Native network capture is on for ${PKG} on ${WIRELESS}, which may also be the device this profile runs on`
        );
      });

      // A provider's emulator drives its simulator-server by its `ext:` id, which
      // adb does not list, although adb read the device under its serial.
      it("asks the probe to wait for a driven id's serial without reporting it", async () => {
        const PROVIDER_ID = "ext:acme-3f2a9c:emulator-5556";
        const unregister = registerCaptureOnDemandSender(
          PROVIDER_ID,
          "ws://127.0.0.1:9000",
          () => {}
        );
        try {
          findRuntimeDevices.mockResolvedValue(foundOn(SERIAL));

          await start(ANDROID_APP);

          expect(findRuntimeDevices).toHaveBeenCalledWith(expect.anything(), {
            awaitSerials: [],
            waitSerials: ["emulator-5556"],
          });
        } finally {
          unregister();
        }
      });

      // The agent passes one serial to every tool, so capture and the
      // simulator-server are usually under the same serial.
      it("names a driven serial the probe could not read when capture is kept under it", async () => {
        const WIRELESS = "192.168.1.5:5555";
        liveSerials.mockReturnValue([WIRELESS]);
        const unregister = registerCaptureOnDemandSender(WIRELESS, "ws://127.0.0.1:9000", () => {});
        try {
          findRuntimeDevices.mockResolvedValue({ found: [SERIAL], unresolved: [WIRELESS] });
          live.mockImplementation((deviceId) => (deviceId === WIRELESS ? [PKG] : []));

          const result = await start(ANDROID_APP);

          expect(result.warning).toContain(
            `Native network capture is on for ${PKG} on ${WIRELESS}, which may also be the device this profile runs on`
          );
        } finally {
          unregister();
        }
      });

      it("still probes when the capture lookup fails", async () => {
        liveSerials.mockImplementation(() => {
          throw new Error("registry unavailable");
        });
        findRuntimeDevices.mockResolvedValue(foundOn(SERIAL));

        const result = await start(ANDROID_APP);

        expect(findRuntimeDevices).toHaveBeenCalledWith(expect.anything(), {
          awaitSerials: [],
          waitSerials: [],
        });
        expect(result.started_at).toBe(new Date(1_000).toISOString());
      });
    });
  });
});
