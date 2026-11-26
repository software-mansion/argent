import { afterEach, describe, expect, it, vi } from "vitest";

const simctlMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (...args: unknown[]) => {
    execFileMock(...args);
    const done = args.at(-1);
    if (typeof done === "function") done(null, { stdout: "", stderr: "" });
  },
}));

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return { ...actual, xcodeFirstLaunchPending: () => false };
});

vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return {
    ...actual,
    execSimctl: async (args: readonly string[]) => simctlMock("xcrun", args).stdout,
  };
});

import { ServiceState, type DeviceInfo } from "@argent/registry";
import { iosImpl as openUrlIos } from "../src/tools/open-url/platforms/ios";
import { dispatchByPlatform } from "../src/utils/cross-platform-tool";
import { armSimulator, startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { targetSimulators, watcherRegistry } from "./helpers/watcher-registry";

const UDID = "11111111-1111-1111-1111-111111111111";
const OTHER_UDID = "22222222-2222-2222-2222-222222222222";
const IOS_DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

function listsBooted(): void {
  simctlMock.mockReturnValue({
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
          { udid: UDID, state: "Booted" },
          { udid: OTHER_UDID, state: "Booted" },
        ],
      },
    }),
    stderr: "",
  });
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  simctlMock.mockReset();
});

describe("armSimulator", () => {
  it("resolves only the simulator it is given, leaves the attempt to its factory, and settles after it", async () => {
    vi.useFakeTimers();
    listsBooted();
    let finishInit!: () => void;
    const ensureEnvReady = vi.fn(async () => {});
    const resolveService = vi.fn(
      (_urn: string) =>
        new Promise((resolve) => {
          finishInit = () => resolve({ ensureEnvReady });
        })
    );
    const registry = watcherRegistry({ resolveService });
    ({ stop } = startSimulatorWatcher(registry));

    const armed = armSimulator(UDID);
    expect(await isSettled(armed)).toBe(false);

    finishInit();
    expect(await isSettled(armed)).toBe(true);
    expect(ensureEnvReady).not.toHaveBeenCalled();
    expect(resolveService.mock.calls.map(([urn]) => urn)).toEqual([`NativeDevtools:${UDID}`]);
  });

  it("settles when the service cannot be resolved", async () => {
    vi.useFakeTimers();
    listsBooted();
    const resolveService = vi.fn(async () => {
      throw new Error("structural");
    });
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    expect(await isSettled(armSimulator(UDID))).toBe(true);
  });

  it("stops waiting after 15s when the arming never settles", async () => {
    vi.useFakeTimers();
    listsBooted();
    const resolveService = vi.fn(() => new Promise(() => {}));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    const armed = armSimulator(UDID);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await isSettled(armed)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await isSettled(armed)).toBe(true);
  });

  it("settles at once while no watcher runs", async () => {
    vi.useFakeTimers();
    expect(await isSettled(armSimulator(UDID))).toBe(true);
  });

  it("starts on a cross-platform tool call on an iOS simulator without holding its handler", async () => {
    listsBooted();
    const resolveService = vi.fn((_urn: string) => new Promise(() => {}));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));
    const execute = dispatchByPlatform({
      toolId: "probe",
      capability: { apple: { simulator: true }, android: { emulator: true } },
      ios: { handler: async () => "handled" },
      android: { handler: async () => "android" },
    });

    expect(await execute({}, { udid: UDID })).toBe("handled");
    expect(resolveService.mock.calls.map(([urn]) => urn)).toEqual([`NativeDevtools:${UDID}`]);
  });

  it("is awaited by open-url on an iOS simulator before it opens the URL", async () => {
    vi.useFakeTimers();
    listsBooted();
    let finishInit!: () => void;
    const resolveService = vi.fn(
      () =>
        new Promise((resolve) => (finishInit = () => resolve({ ensureEnvReady: async () => {} })))
    );
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));
    execFileMock.mockClear();

    const opened = openUrlIos.handler({}, { udid: UDID, url: "myapp://home" }, IOS_DEVICE, {});
    opened.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).not.toHaveBeenCalled();

    finishInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock.mock.calls[0]?.[1]).toContain("openurl");
  });

  it("shares one attempt and one deadline between concurrent calls for a simulator", async () => {
    vi.useFakeTimers();
    listsBooted();
    const resolveService = vi.fn(() => new Promise(() => {}));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    const first = armSimulator(UDID);
    await vi.advanceTimersByTimeAsync(10_000);
    const second = armSimulator(UDID);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await isSettled(second)).toBe(true);
    expect(await isSettled(first)).toBe(true);
    expect(resolveService).toHaveBeenCalledTimes(1);
  });

  it("shares one attempt between calls that spell a simulator in different cases", async () => {
    vi.useFakeTimers();
    listsBooted();
    const lettered = "ABCDEF01-2345-4678-9ABC-DEF012345678";
    const resolveService = vi.fn(() => new Promise(() => {}));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    void armSimulator(lettered);
    void armSimulator(lettered.toLowerCase());
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveService).toHaveBeenCalledTimes(1);
  });

  it("is not awaited by a cross-platform tool call on an Android device", async () => {
    listsBooted();
    const resolveService = vi.fn(async () => ({ ensureEnvReady: async () => {} }));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));
    const execute = dispatchByPlatform({
      toolId: "probe",
      capability: { apple: { simulator: true }, android: { emulator: true } },
      ios: { handler: async () => "ios" },
      android: { handler: async () => "android" },
    });

    await execute({}, { udid: "emulator-5554" });

    expect(resolveService).not.toHaveBeenCalled();
  });
});

describe("ARGENT_SIMULATOR_WATCH_UDIDS", () => {
  it("arms a listed simulator whatever its case, and settles at once for an unlisted one", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARGENT_SIMULATOR_WATCH_UDIDS", ` ${UDID.toLowerCase()} `);
    listsBooted();
    const resolveService = vi.fn(() => new Promise(() => {}));
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    expect(await isSettled(armSimulator(OTHER_UDID))).toBe(true);
    expect(resolveService).not.toHaveBeenCalled();

    expect(await isSettled(armSimulator(UDID))).toBe(false);
    expect(resolveService).toHaveBeenCalledTimes(1);
  });

  it("arms no simulator when the list is empty", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARGENT_SIMULATOR_WATCH_UDIDS", "");
    listsBooted();
    const resolveService = vi.fn();
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));

    expect(await isSettled(armSimulator(UDID))).toBe(true);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("does not re-arm an unlisted simulator that a tool targeted", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARGENT_SIMULATOR_WATCH_UDIDS", UDID);
    listsBooted();
    const resolveService = vi.fn(async (_urn: string) => ({
      isEnvSetup: () => true,
      getInitFailure: () => null,
    }));
    const registry = watcherRegistry({ resolveService });
    const watcher = startSimulatorWatcher(registry);
    stop = watcher.stop;
    await watcher.ready;

    targetSimulators(registry, UDID, OTHER_UDID);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(resolveService.mock.calls.map(([urn]) => urn)).toEqual([`NativeDevtools:${UDID}`]);
  });
});

describe("an arm after the simulator's first service", () => {
  const LETTERED = "ABCDEF01-2345-4678-9ABC-DEF012345678";

  function listsLettered(): void {
    simctlMock.mockReturnValue({
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ udid: LETTERED, state: "Booted" }],
        },
      }),
      stderr: "",
    });
  }

  function runningUnder(udid: string) {
    const ensureEnvReady = vi.fn(async () => {});
    const resolveService = vi.fn(async (_urn: string) => ({
      ensureEnvReady,
      reverifyEnv: async () => {},
      isEnvSetup: () => true,
      getInitFailure: () => null,
    }));
    const disposeService = vi.fn(async () => {});
    const getServiceState = (urn: string) =>
      urn === `NativeDevtools:${udid}` ? ServiceState.RUNNING : ServiceState.IDLE;
    const registry = watcherRegistry({ resolveService, disposeService, getServiceState });
    return { registry, resolveService, disposeService, ensureEnvReady };
  }

  it("retries the running service instead of starting one under another spelling", async () => {
    vi.useFakeTimers();
    listsLettered();
    const { registry, resolveService, disposeService, ensureEnvReady } = runningUnder(LETTERED);
    const watcher = startSimulatorWatcher(registry);
    stop = watcher.stop;
    await watcher.ready;
    targetSimulators(registry, LETTERED);

    await armSimulator(LETTERED.toLowerCase());
    targetSimulators(registry, LETTERED.toLowerCase());
    await vi.advanceTimersByTimeAsync(20_000);

    expect(new Set(resolveService.mock.calls.map(([urn]) => urn))).toEqual(
      new Set([`NativeDevtools:${LETTERED}`])
    );
    expect(ensureEnvReady).toHaveBeenCalled();
    expect(disposeService).not.toHaveBeenCalled();
  });
});
