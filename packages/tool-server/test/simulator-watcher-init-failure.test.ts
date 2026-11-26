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

// The watcher reaches simctl through execSimctl (a detached spawn); route it
// through the same mock so tests script its output alongside execFile's.
vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return {
    ...actual,
    execSimctl: async (args: readonly string[]) => {
      const result = await execFileMock("xcrun", args);
      if (result instanceof Error) throw result;
      return (result ?? { stdout: "" }).stdout;
    },
  };
});

import type { Registry } from "@argent/registry";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import { armSimulator, startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { targetSimulators, untargetSimulators, watcherRegistry } from "./helpers/watcher-registry";

const UDID = "11111111-1111-1111-1111-111111111111";
/** Booted alongside, but no tool has targeted it. */
const OTHER_UDID = "22222222-2222-2222-2222-222222222222";
/** Has letters, so its lowercase spelling differs from what `simctl list` prints. */
const LETTERED_UDID = "ABCDEF01-2345-4678-9ABC-DEF012345678";

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
    reverifyEnv: async () => {},
    armsEnv: true,
    withdrawEnv: async () => {},
    getInitFailure: () => initFailure,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    appConnectionState: async () => "stale_process",
    startNetworkCapture: async () => false,
    stopNetworkCapture: async () => ({ confirmed: true }),
    isNetworkCaptureStarted: () => false,
    isNetworkCaptureStopped: () => false,
    networkCaptureMark: () => undefined,
    refreshLentNetworkCapture: async () => {},
    takeCaptureGap: () => false,
    networkRecords: () => undefined,
    networkCaptureAfterLaunch: async () => undefined,
    setNetworkConditions: async () => {},
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
  const resolveService = vi.fn(async (_urn: string) => {
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
    registry: watcherRegistry({ resolveService, disposeService }),
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
    const bootedUdids: string[] = [UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    const { api, ensureCalls } = makeFailingApi();
    const { registry } = makeRegistry(api);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      targetSimulators(registry, UDID);
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
    const bootedUdids: string[] = [UDID];
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
      reverifyEnv: async () => {},
      armsEnv: true,
      withdrawEnv: async () => {},
      getInitFailure: () => null,
      isConnected: () => false,
      isAppRunning: async () => false,
      listConnectedBundleIds: () => [],
      appConnectionState: async () => "stale_process",
      startNetworkCapture: async () => false,
      stopNetworkCapture: async () => ({ confirmed: true }),
      isNetworkCaptureStarted: () => false,
      isNetworkCaptureStopped: () => false,
      networkCaptureMark: () => undefined,
      refreshLentNetworkCapture: async () => {},
      takeCaptureGap: () => false,
      networkRecords: () => undefined,
      networkCaptureAfterLaunch: async () => undefined,
      setNetworkConditions: async () => {},
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
      targetSimulators(registry, UDID);
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
      targetSimulators(registry, UDID);
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

  it("leaves a booted simulator no tool targeted alone", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse([UDID, OTHER_UDID]);
      return { stdout: "", stderr: "" };
    });

    const { api } = makeFailingApi();
    const { registry, resolveService } = makeRegistry(api);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      expect(resolveService).not.toHaveBeenCalled();

      targetSimulators(registry, UDID);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(resolveService.mock.calls.map(([urn]) => urn)).toEqual([`NativeDevtools:${UDID}`]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["in upper case", LETTERED_UDID],
    ["in lower case", LETTERED_UDID.toLowerCase()],
  ])("arms a simulator a tool named %s again after it reboots", async (_case, target) => {
    let bootedUdids: string[] = [LETTERED_UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    let calls = 0;
    const { api } = makeFailingApi();
    const counted = {
      ...api,
      isEnvSetup: () => true,
      ensureEnvReady: () => {
        calls += 1;
        return Promise.resolve();
      },
    };
    const { registry, resolveService } = makeRegistry(counted);

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      targetSimulators(registry, target);
      await ready;
      expect(calls).toBe(1);

      bootedUdids = [];
      await vi.advanceTimersByTimeAsync(10_000);
      bootedUdids = [LETTERED_UDID];
      await vi.advanceTimersByTimeAsync(10_000);

      expect(calls).toBe(2);
      expect(new Set(resolveService.mock.calls.map(([urn]) => urn))).toEqual(
        new Set([`NativeDevtools:${target}`])
      );
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-arming a simulator once a tool stopped its service", async () => {
    let bootedUdids: string[] = [UDID];
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse(bootedUdids);
      return { stdout: "", stderr: "" };
    });

    const { api } = makeFailingApi();
    const { registry, resolveService } = makeRegistry({ ...api, isEnvSetup: () => true });

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      targetSimulators(registry, UDID);
      await ready;
      expect(resolveService).toHaveBeenCalledTimes(1);

      untargetSimulators(registry, UDID);
      bootedUdids = [];
      await vi.advanceTimersByTimeAsync(10_000);
      bootedUdids = [UDID];
      await vi.advanceTimersByTimeAsync(10_000);

      expect(resolveService).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the service of a simulator a tool named in lowercase while it runs", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse([LETTERED_UDID]);
      return { stdout: "", stderr: "" };
    });

    const { api } = makeFailingApi();
    const { registry, disposeService } = makeRegistry({ ...api, isEnvSetup: () => true });

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await armSimulator(LETTERED_UDID.toLowerCase());
      targetSimulators(registry, LETTERED_UDID.toLowerCase());
      await vi.advanceTimersByTimeAsync(20_000);

      expect(disposeService).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the service of an armed simulator that no poll lists, as in a provider's own set", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return bootedListResponse([UDID]);
      return { stdout: "", stderr: "" };
    });

    const { api } = makeFailingApi();
    const { registry, disposeService } = makeRegistry({ ...api, isEnvSetup: () => true });

    vi.useFakeTimers();
    try {
      const { ready, stop } = startSimulatorWatcher(registry);
      await ready;
      await armSimulator(OTHER_UDID);
      targetSimulators(registry, OTHER_UDID);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(disposeService).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
