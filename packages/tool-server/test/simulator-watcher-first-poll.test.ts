import { afterEach, describe, expect, it, vi } from "vitest";

const simctlMock = vi.fn();

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
