import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import type { ReactProfilerSessionApi } from "../../src/blueprints/react-profiler-session";
import { STOP_FOR_TAKEOVER_SCRIPT } from "../../src/utils/react-profiler/scripts";
import {
  rememberLogicalKeyedDevice,
  resetDeviceAliases,
} from "../../src/utils/debugger/device-alias";
import { __resetProfilingDevicesForTesting, isProfiling } from "../../src/utils/profiling-devices";

import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";

const findRuntimeDeviceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => undefined)
);
vi.mock("../../src/utils/debugger/runtime-device", () => ({
  findRuntimeDevice: () => findRuntimeDeviceMock(),
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
  findRuntimeDeviceMock.mockReset();
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

  it("registers a run keyed by a logicalDeviceId under the device it runs on too", async () => {
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    findRuntimeDeviceMock.mockResolvedValue("emulator-5554");
    const { registry } = fakeSession(LOGICAL_ID);
    const tool = createReactProfilerStartTool(registry);

    const result = await tool.execute(
      {},
      { device_id: LOGICAL_ID, port: 8081, sample_interval_us: 100, force: false }
    );

    expect(isProfiling("emulator-5554")).toBe(true);
    expect(isProfiling(LOGICAL_ID)).toBe(true);
    expect(result).not.toHaveProperty("__argentNote");
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

    expect(findRuntimeDeviceMock).not.toHaveBeenCalled();
    expect(isProfiling("emulator-5554")).toBe(true);
  });
});
