import { afterEach, describe, expect, it, vi } from "vitest";

const simctlMock = vi.fn();

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

import { dispatchByPlatform } from "../src/utils/cross-platform-tool";
import { armSimulator, startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { watcherRegistry } from "./helpers/watcher-registry";

const UDID = "11111111-1111-1111-1111-111111111111";
const OTHER_UDID = "22222222-2222-2222-2222-222222222222";

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

  it("is awaited by a cross-platform tool call on an iOS simulator before its handler runs", async () => {
    listsBooted();
    const order: string[] = [];
    const resolveService = vi.fn(async (urn: string) => {
      order.push(urn);
      return { ensureEnvReady: async () => {} };
    });
    ({ stop } = startSimulatorWatcher(watcherRegistry({ resolveService })));
    const execute = dispatchByPlatform({
      toolId: "probe",
      capability: { apple: { simulator: true }, android: { emulator: true } },
      ios: { handler: async () => order.push("handler") },
      android: { handler: async () => order.push("handler") },
    });

    await execute({}, { udid: UDID });

    expect(order).toEqual([`NativeDevtools:${UDID}`, "handler"]);
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
