import { afterEach, describe, expect, it, vi } from "vitest";

const simctlMock = vi.fn();
const pending = vi.hoisted(() => ({ simctl: false }));

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return {
    ...actual,
    xcodeFirstLaunchPending: (wrapper: string) => wrapper === "simctl" && pending.simctl,
  };
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

import type { Registry } from "@argent/registry";
import { firstSimulatorPoll, startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { SimctlTimeoutError } from "../src/utils/simctl-exec";

const UDID = "11111111-1111-1111-1111-111111111111";

function listsBooted(): void {
  simctlMock.mockReturnValue({
    stdout: JSON.stringify({
      devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ udid: UDID, state: "Booted" }] },
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
  pending.simctl = false;
});

describe("firstSimulatorPoll", () => {
  it("settles once the first poll has armed every booted simulator", async () => {
    vi.useFakeTimers();
    listsBooted();
    let finishInit!: () => void;
    const resolveService = vi.fn(
      () =>
        new Promise((resolve) => {
          finishInit = () => resolve({ getInitFailure: () => null });
        })
    );

    ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));

    expect(await isSettled(firstSimulatorPoll())).toBe(false);
    expect(resolveService).toHaveBeenCalledWith(`NativeDevtools:${UDID}`, expect.anything());

    finishInit();
    expect(await isSettled(firstSimulatorPoll())).toBe(true);
  });

  it("keeps waiting past a first poll whose simctl failed, until a poll arms", async () => {
    vi.useFakeTimers();
    simctlMock.mockImplementationOnce(() => {
      throw new Error("CoreSimulatorService connection interrupted");
    });
    listsBooted();
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));

    ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolveService).not.toHaveBeenCalled();
    expect(await isSettled(firstSimulatorPoll())).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveService).toHaveBeenCalledWith(`NativeDevtools:${UDID}`, expect.anything());
    expect(await isSettled(firstSimulatorPoll())).toBe(true);
  });

  it("waits out the 15s cap when the first simctl times out and backs off past it", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    simctlMock.mockImplementationOnce(() => {
      throw new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);
    });
    listsBooted();
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));

    try {
      ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(simctlMock).toHaveBeenCalledTimes(1);
      expect(await isSettled(firstSimulatorPoll())).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await isSettled(firstSimulatorPoll())).toBe(true);
      expect(resolveService).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("settles at once while Xcode's component install is pending", async () => {
    vi.useFakeTimers();
    pending.simctl = true;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resolveService = vi.fn();

    try {
      ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));

      expect(await isSettled(firstSimulatorPoll())).toBe(true);
      expect(simctlMock).not.toHaveBeenCalled();
      expect(resolveService).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("stops waiting 15s after startup when the first poll never settles", async () => {
    vi.useFakeTimers();
    listsBooted();
    const resolveService = vi.fn(() => new Promise(() => {}));

    ({ stop } = startSimulatorWatcher({ resolveService } as unknown as Registry));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(await isSettled(firstSimulatorPoll())).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await isSettled(firstSimulatorPoll())).toBe(true);
  });
});
