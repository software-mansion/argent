/**
 * Issue #1721: an idle server must not keep asking `simctl` for simulators
 * while Xcode's component install is pending, since every call would start the
 * install and leave another administrator-password request behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ simctl: false }));
const execSimctlMock = vi.fn();

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
  return { ...actual, execSimctl: (...args: unknown[]) => execSimctlMock(...args) };
});

vi.mock("../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-device-sets")>(
    "../src/utils/ios-device-sets"
  );
  return { ...actual, configuredAdditionalDeviceSets: () => [] };
});

import type { Registry } from "@argent/registry";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const registry = {
  resolveService: vi.fn(),
  disposeService: vi.fn(async () => {}),
} as unknown as Registry;

let stderrWrites: string[];

function installHints(): string[] {
  return stderrWrites.filter((line) => line.includes("sudo xcodebuild -runFirstLaunch"));
}

beforeEach(() => {
  pending.simctl = false;
  execSimctlMock.mockReset();
  execSimctlMock.mockResolvedValue('{"devices":{}}');
  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("simulator-watcher while Xcode's component install is pending", () => {
  it("starts without calling simctl, so the server binds at once, and says why once", async () => {
    pending.simctl = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(execSimctlMock).not.toHaveBeenCalled();
    expect(installHints()).toHaveLength(1);
    stop();
  });

  it("polls again on the first tick after the install, and says why again on a new outage", async () => {
    pending.simctl = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).not.toHaveBeenCalled();

    pending.simctl = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);

    pending.simctl = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);
    expect(installHints()).toHaveLength(2);
    stop();
  });
});
