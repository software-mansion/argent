import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) {
        const e = result as Error & { stderr?: string; stdout?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else {
        callback(null, result ?? { stdout: "", stderr: "" });
      }
    },
  };
});

import type { Registry } from "@argent/registry";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const UDID = "11111111-1111-1111-1111-111111111111";

function bootedListResponse(udids: string[]): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": udids.map((udid) => ({
          udid,
          state: "Booted",
        })),
      },
    }),
    stderr: "",
  };
}

function makeFailingApi(): { api: NativeDevtoolsApi; ensureCalls: () => number } {
  let initFailure: NativeDevtoolsInitFailure | null = null;
  let calls = 0;
  const api: NativeDevtoolsApi = {
    isEnvSetup: () => false,
    socketPath: "/tmp/mock.sock",
    ensureEnvReady: async () => {
      calls += 1;
      if (initFailure?.givenUp) return;
      const attempts = (initFailure?.attempts ?? 0) + 1;
      initFailure = {
        attempts,
        lastError: "stub ensureEnv failure",
        givenUp: attempts >= MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
      };
      throw new Error("stub ensureEnv failure");
    },
    getInitFailure: () => initFailure,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    requiresAppRestart: async () => true,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  };
  return { api, ensureCalls: () => calls };
}

function makeRegistry(api: NativeDevtoolsApi): {
  registry: Registry;
  resolveService: ReturnType<typeof vi.fn>;
  disposeService: ReturnType<typeof vi.fn>;
} {
  // Mimic the registry: factory runs once, subsequent resolveService calls
  // return the cached api. Attempt counts only go up when the watcher itself
  // calls api.ensureEnvReady().
  let factoryRan = false;
  const resolveService = vi.fn(async () => {
    if (!factoryRan) {
      factoryRan = true;
      await api.ensureEnvReady().catch(() => {});
    }
    return api;
  });
  const disposeService = vi.fn(async () => {
    factoryRan = false;
  });
  return {
    registry: { resolveService, disposeService } as unknown as Registry,
    resolveService,
    disposeService,
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("simulator-watcher with api-owned init failure state", () => {
  it("stops calling ensureEnvReady after the api reports givenUp", async () => {
    let bootedUdids: string[] = [UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    const { api, ensureCalls } = makeFailingApi();
    const { registry } = makeRegistry(api);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;

      while ((api.getInitFailure()?.attempts ?? 0) < MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS) {
        await vi.advanceTimersByTimeAsync(10_000);
      }

      const failure = api.getInitFailure();
      expect(failure?.attempts).toBe(MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS);
      expect(failure?.givenUp).toBe(true);

      const callsAtCap = ensureCalls();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ensureCalls()).toBe(callsAtCap);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no further ensureEnvReady calls for a healthy UDID after init", async () => {
    let bootedUdids: string[] = [UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    let calls = 0;
    const api: NativeDevtoolsApi = {
      isEnvSetup: () => true,
      socketPath: "/tmp/mock.sock",
      ensureEnvReady: async () => {
        calls += 1;
      },
      getInitFailure: () => null,
      isConnected: () => false,
      isAppRunning: async () => false,
      listConnectedBundleIds: () => [],
      requiresAppRestart: async () => true,
      activateNetworkInspection: () => {},
      getNetworkLog: () => [],
      clearNetworkLog: () => {},
      getAppState: async () => {
        throw new Error("not implemented");
      },
      detectFrontmostBundleId: async () => null,
      queryViewHierarchy: async () => ({}),
    };
    const { registry } = makeRegistry(api);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      const callsAfterInit = calls;

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(callsAfterInit);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the service when the UDID leaves the booted set", async () => {
    let bootedUdids: string[] = [UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    const { api } = makeFailingApi();
    const { registry, disposeService } = makeRegistry(api);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      expect(disposeService).not.toHaveBeenCalled();

      bootedUdids = [];
      await vi.advanceTimersByTimeAsync(10_000);

      expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${UDID}`);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
