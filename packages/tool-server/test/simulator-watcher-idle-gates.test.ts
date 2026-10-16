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
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const UDID = "11111111-1111-1111-1111-111111111111";
const TICK_MS = 10_000;

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

/** pgrep's "no process matched" exit. */
function pgrepNoMatch(): Error {
  return Object.assign(new Error("pgrep exited 1"), { code: 1 });
}

function makeHealthyApi(): NativeDevtoolsApi {
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/mock.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    appConnectionState: async () => "stale_process",
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  };
}

function makeRegistry(api: NativeDevtoolsApi): {
  registry: Registry;
  resolveService: ReturnType<typeof vi.fn>;
  disposeService: ReturnType<typeof vi.fn>;
} {
  const resolveService = vi.fn(async () => api);
  const disposeService = vi.fn(async () => {});
  return {
    registry: { resolveService, disposeService } as unknown as Registry,
    resolveService,
    disposeService,
  };
}

/** The scripted host: which processes pgrep sees and what simctl reports. */
function scriptHost(state: { launchdSim: boolean; booted: string[]; pgrepError?: Error }) {
  execFileMock.mockImplementation((cmd: string) => {
    if (cmd === "pgrep") {
      if (state.pgrepError) return state.pgrepError;
      return state.launchdSim ? { stdout: "123\n", stderr: "" } : pgrepNoMatch();
    }
    if (cmd === "xcrun") return bootedListResponse(state.booted);
    return { stdout: "", stderr: "" };
  });
}

function xcrunCalls(): number {
  return execFileMock.mock.calls.filter(([cmd]) => cmd === "xcrun").length;
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("simulator-watcher · launchd_sim gate", () => {
  it("does not ask simctl while no simulator process is running and nothing is tracked", async () => {
    const host = { launchdSim: false, booted: [] as string[] };
    scriptHost(host);
    const { registry, resolveService } = makeRegistry(makeHealthyApi());

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(xcrunCalls()).toBe(0);
    expect(resolveService).not.toHaveBeenCalled();

    // A simulator boots: launchd_sim appears, the next tick goes to simctl.
    host.launchdSim = true;
    host.booted = [UDID];
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(xcrunCalls()).toBe(1);
    expect(resolveService).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps asking simctl for a tracked simulator so its shutdown is disposed", async () => {
    const host = { launchdSim: true, booted: [UDID] };
    scriptHost(host);
    const { registry, disposeService } = makeRegistry(makeHealthyApi());

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    expect(xcrunCalls()).toBe(1);

    // Simulator shut down: launchd_sim is gone, but the UDID is still tracked,
    // so the gate must not short-circuit the tick that disposes it.
    host.launchdSim = false;
    host.booted = [];
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(xcrunCalls()).toBe(2);
    expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${UDID}`);

    // Now nothing is tracked and nothing runs: back to skipping simctl.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(xcrunCalls()).toBe(2);
    stop();
  });

  it("falls back to simctl when pgrep fails for a reason other than 'no match'", async () => {
    scriptHost({
      launchdSim: false,
      booted: [UDID],
      pgrepError: Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" }),
    });
    const { registry, resolveService } = makeRegistry(makeHealthyApi());

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;

    expect(xcrunCalls()).toBe(1);
    expect(resolveService).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("simulator-watcher · client activity gate", () => {
  it("pauses interval polls once client activity is stale and resumes when it is fresh", async () => {
    scriptHost({ launchdSim: true, booted: [UDID] });
    const { registry } = makeRegistry(makeHealthyApi());

    let lastActivityAt = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry, {
      lastActivityAt: () => lastActivityAt,
    });
    await ready;
    expect(xcrunCalls()).toBe(1);

    // Fresh activity: ticks poll.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(xcrunCalls()).toBe(2);

    // Three minutes without a request (an orphaned autospawn): ticks skip.
    lastActivityAt = Date.now() - 3 * 60_000;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(xcrunCalls()).toBe(2);

    // A request arrives: the next tick polls again.
    lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(xcrunCalls()).toBe(3);
    stop();
  });

  it("polls unconditionally when no activity source is given", async () => {
    scriptHost({ launchdSim: true, booted: [UDID] });
    const { registry } = makeRegistry(makeHealthyApi());

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(xcrunCalls()).toBe(3);
    stop();
  });
});
