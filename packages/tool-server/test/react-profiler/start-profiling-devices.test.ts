import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import type { ReactProfilerSessionApi } from "../../src/blueprints/react-profiler-session";
import { STOP_FOR_TAKEOVER_SCRIPT } from "../../src/utils/react-profiler/scripts";
import {
  rememberLogicalKeyedDevice,
  resetDeviceAliases,
} from "../../src/utils/debugger/device-alias";
import {
  __resetProfilingDevicesForTesting,
  isProfiling,
  registerCaptureOnDemandSender,
} from "../../src/utils/profiling-devices";
import { registerIosNetworkCaptures } from "../../src/blueprints/ios-network-records";

import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";
import type { RuntimeDevices } from "../../src/utils/debugger/runtime-device";

type ProbeOptions = { awaitSerials?: readonly string[]; waitSerials?: readonly string[] };
const findRuntimeDevicesMock = vi.hoisted(() =>
  vi.fn(async (_cdp?: unknown, _opts?: ProbeOptions): Promise<RuntimeDevices> => ({
    found: [],
    unresolved: [],
  }))
);
vi.mock("../../src/utils/debugger/runtime-device", () => ({
  findRuntimeDevices: (cdp: unknown, opts?: ProbeOptions) => findRuntimeDevicesMock(cdp, opts),
}));

const LOGICAL_ID = "1c3346c4a6889e88dbb8116da34f0f4af6f8067c";

/**
 * A session whose app answers every start script. `onStart` runs while the
 * start script is in flight, which is where a teardown can land.
 */
function fakeSession(deviceId: string, onStart: (api: ReactProfilerSessionApi) => void = () => {}) {
  const evaluated: string[] = [];
  const sent: string[] = [];
  const api = {
    port: 8081,
    deviceId,
    hermesVersion: "0.14.0",
    detectedArchitecture: "bridgeless",
    profilingActive: false,
    disposed: false,
    cdp: {
      isConnected: () => true,
      send: async (method: string) => {
        sent.push(method);
        return {};
      },
      evaluate: async (expression: string) => {
        evaluated.push(expression);
        if (expression.includes("__argent_readState")) {
          return JSON.stringify({
            hookExists: true,
            rendererInterfaceFound: true,
            isRunning: false,
            owner: null,
            nowEpochMs: Date.now(),
          });
        }
        if (expression.includes("__argent_doStart")) {
          onStart(api);
          return JSON.stringify({
            ok: true,
            startedAtEpochMs: Date.now(),
            isProfilingFlagSet: true,
            ownerInstalled: true,
          });
        }
        return undefined;
      },
    },
  } as unknown as ReactProfilerSessionApi;
  const registry = {
    getSnapshot: () => ({ services: new Map() }),
    resolveService: async () => api,
  } as unknown as Registry;
  return { api, registry, evaluated, sent };
}

afterEach(() => {
  __resetProfilingDevicesForTesting();
  resetDeviceAliases();
  findRuntimeDevicesMock.mockReset();
  findRuntimeDevicesMock.mockResolvedValue({ found: [], unresolved: [] });
});

describe("react-profiler-start registers the run where the device's calls look", () => {
  it("registers nothing when a teardown disposed the session mid-start, and stops the app", async () => {
    const { registry, evaluated, sent } = fakeSession("emulator-5554", (api) => {
      api.disposed = true;
    });
    const tool = createReactProfilerStartTool(registry);

    const err = await tool
      .execute(
        {},
        { device_id: "emulator-5554", port: 8081, sample_interval_us: 100, force: false }
      )
      .catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_SESSION_TORN_DOWN);
    expect(isProfiling("emulator-5554")).toBe(false);
    expect(evaluated.at(-1)).toBe(STOP_FOR_TAKEOVER_SCRIPT);
    expect(sent.at(-1)).toBe("Profiler.stop");
  });

  it("registers a run keyed by a logicalDeviceId under every id of the device it runs on too", async () => {
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    findRuntimeDevicesMock.mockResolvedValue({
      found: ["emulator-5554", "127.0.0.1:5555"],
      unresolved: [],
    });
    const { api, registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    const result = await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling("emulator-5554")).toBe(true);
    expect(isProfiling("127.0.0.1:5555")).toBe(true);
    expect(isProfiling(LOGICAL_ID)).toBe(true);
    expect(result).not.toHaveProperty("__argentNote");

    // Every way a run ends clears the session's flag, which releases them all.
    api.profilingActive = false;
    for (const id of ["emulator-5554", "127.0.0.1:5555", LOGICAL_ID]) {
      expect(isProfiling(id)).toBe(false);
    }
  });

  // Only an awaited serial is kept when it answers after the grace window, so
  // the probe must await the one the agent drives the device by.
  it("asks the probe to wait in full for a serial with a simulator-server", async () => {
    const WIRELESS = "192.168.1.5:5555";
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    const sends: boolean[] = [];
    registerCaptureOnDemandSender(WIRELESS, "ws://127.0.0.1:9000", (onDemand) =>
      sends.push(onDemand)
    );
    findRuntimeDevicesMock.mockImplementation(async (_cdp, opts) => ({
      found: opts?.waitSerials?.includes(WIRELESS) ? ["R58M123ABC", WIRELESS] : ["R58M123ABC"],
      unresolved: [],
    }));
    const { registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling(WIRELESS)).toBe(true);
    expect(sends).toEqual([true]);
  });

  it("adds no unknown-device note when the device is found under one serial", async () => {
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    findRuntimeDevicesMock.mockResolvedValue({ found: ["emulator-5554"], unresolved: [] });
    const { registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    const result = await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling("emulator-5554")).toBe(true);
    expect(result).not.toHaveProperty("__argentNote");
  });

  // A provider's device is driven by its `ext:` id, while adb finds it by the
  // serial behind it.
  it("registers the run under a provider's id for the found serial", async () => {
    const PROVIDER_ID = "ext:acme-3f2a9c:emulator-5556";
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    const sends: boolean[] = [];
    registerCaptureOnDemandSender(PROVIDER_ID, "ws://127.0.0.1:9000", (onDemand) =>
      sends.push(onDemand)
    );
    registerCaptureOnDemandSender("ext:acme-3f2a9c:emulator-5558", "ws://127.0.0.1:9001", () => {});
    findRuntimeDevicesMock.mockResolvedValue({ found: ["emulator-5556"], unresolved: [] });
    const { api, registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling(PROVIDER_ID)).toBe(true);
    expect(sends).toEqual([true]);
    expect(isProfiling("ext:acme-3f2a9c:emulator-5558")).toBe(false);

    api.profilingActive = false;
    expect(isProfiling(PROVIDER_ID)).toBe(false);
    expect(isProfiling("emulator-5556")).toBe(false);
    expect(sends).toEqual([true, false]);
  });

  it("notes that captures go on when the device cannot be found", async () => {
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    const { registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    const result = await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling(LOGICAL_ID)).toBe(true);
    expect(result.__argentNote).toMatch(/could not tell which of them runs this app/);
  });

  it("does not look for the device of a session keyed by the device's own id", async () => {
    const { registry } = fakeSession("emulator-5554");
    const tool = createReactProfilerStartTool(registry);

    await tool.execute(
      {},
      { device_id: "emulator-5554", port: 8081, sample_interval_us: 100, force: false }
    );

    expect(findRuntimeDevicesMock).not.toHaveBeenCalled();
    expect(isProfiling("emulator-5554")).toBe(true);
  });
});

describe("react-profiler-start looks up native network capture on the device it found", () => {
  const SIM_A = "AAAAAAAA-1111-2222-3333-444444444444";
  const SIM_B = "BBBBBBBB-1111-2222-3333-444444444444";
  const APP = "com.example.networktest";

  /** Capture is on for APP on `udid`, and APP connected there once. */
  function captureOn(udid: string): () => void {
    return registerIosNetworkCaptures({
      udid,
      bundleIds: new Set([APP]),
      stoppedBundleIds: new Set(),
      stores: new Map([[APP, {} as never]]),
    });
  }

  async function startOnSimA(runtimeApp?: { appId: string; platform: "ios" }) {
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    findRuntimeDevicesMock.mockResolvedValue({ found: [SIM_A], unresolved: [] });
    const { api, registry } = fakeSession(LOGICAL_ID);
    Object.assign(api, { runtimeApp });
    return createReactProfilerStartTool(registry).execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );
  }

  it("does not name another simulator that captures the same app", async () => {
    const unregister = captureOn(SIM_B);
    try {
      const result = await startOnSimA({ appId: APP, platform: "ios" });

      expect(isProfiling(SIM_A)).toBe(true);
      expect(result.warning).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("warns about capture on that device, even when the runtime did not say its app", async () => {
    const unregister = captureOn(SIM_A);
    try {
      const result = await startOnSimA();

      expect(result.warning).toContain(
        `Native network capture is on for ${APP} on ${SIM_A}, the device this profile runs on`
      );
    } finally {
      unregister();
    }
  });
});
