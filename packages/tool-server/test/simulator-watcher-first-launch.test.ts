/**
 * Issue #1721: an idle server must not keep asking `simctl` for simulators
 * while Xcode's component install is pending, since every call would start the
 * install and leave another administrator-password request behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ value: false }));
const execSimctlMock = vi.fn();

vi.mock("../src/utils/xcode-first-launch", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/xcode-first-launch")>(
    "../src/utils/xcode-first-launch"
  );
  return { ...actual, xcodeFirstLaunchPending: () => pending.value };
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
import { SimctlTimeoutError } from "../src/utils/simctl-exec";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const registry = {} as unknown as Registry;

const FAKE_APP = "/Applications/Xcode-beta.app";
const realDeveloperDir = process.env.DEVELOPER_DIR;
const timeout = new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);

let stderrWrites: string[];

/** What the watcher logs for this wait, as opposed to the line for a `simctl` that timed out. */
function installLines(): string[] {
  return stderrWrites.filter((line) => line.includes("has not finished installing"));
}

function timeoutLines(): string[] {
  return stderrWrites.filter((line) => line.includes("retrying with backoff"));
}

beforeEach(() => {
  process.env.DEVELOPER_DIR = `${FAKE_APP}/Contents/Developer`;
  pending.value = false;
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
  if (realDeveloperDir === undefined) delete process.env.DEVELOPER_DIR;
  else process.env.DEVELOPER_DIR = realDeveloperDir;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("simulator-watcher while Xcode's component install is pending", () => {
  it("starts without calling simctl, so the server binds at once, and says why once", async () => {
    pending.value = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    expect(execSimctlMock).not.toHaveBeenCalled();
    expect(stderrWrites).toEqual([
      "[simulator-watcher] Xcode has not finished installing its system components, so " +
        `simulators are not polled until it has. To install them, open the Xcode at ${FAKE_APP} ` +
        `once, or run \`sudo ${FAKE_APP}/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch\`.\n`,
    ]);
  });

  it("polls again on the first tick after the install, and says why again on a new wait", async () => {
    pending.value = true;
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execSimctlMock).not.toHaveBeenCalled();

    pending.value = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    expect(execSimctlMock).toHaveBeenCalledTimes(1);
    expect(installLines()).toHaveLength(2);
  });

  it("stops polling once the wrapper starts asking for the install, mid-session", async () => {
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(3);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(execSimctlMock).toHaveBeenCalledTimes(3);
  });

  // The backoff exists because each attempt restarts the hung install. Once the
  // install is done, nothing is left to hold the next poll back for.
  it("drops a backoff left by earlier timeouts, so the first tick after the install polls", async () => {
    const callTimes: number[] = [];
    execSimctlMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (!answers) throw timeout;
      return '{"devices":{}}';
    });
    let answers = false;

    const start = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    // Timeouts at 0, 20 s and 60 s, so the next attempt is due only at 140 s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000]);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(10_000);
    pending.value = false;
    answers = true;
    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000, 80_000]);
  });

  it("is no timeout, so a later hang starts its backoff and its log over", async () => {
    const callTimes: number[] = [];
    execSimctlMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      throw timeout;
    });

    const start = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeoutLines()).toHaveLength(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000]);
    expect(timeoutLines()).toHaveLength(1);

    pending.value = false;
    callTimes.length = 0;
    await vi.advanceTimersByTimeAsync(40_000);
    stop();

    // The first tick is at 670 s, and the gap after a first timeout is 20 s.
    expect(callTimes.map((t) => t - start)).toEqual([670_000, 690_000]);
    expect(timeoutLines()).toHaveLength(2);
  });

  // Asked nothing, so the watcher knows nothing: it must not read that as "shut down".
  it("keeps the simulators it tracks until a poll says they are gone", async () => {
    const udid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const service = { getInitFailure: () => null, armsEnv: true };
    const resolveService = vi.fn(async () => service);
    const disposeService = vi.fn(async () => {});
    execSimctlMock.mockResolvedValue(
      JSON.stringify({
        devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid, state: "Booted" }] },
      })
    );

    const { ready, stop } = startSimulatorWatcher({
      resolveService,
      disposeService,
    } as unknown as Registry);
    await ready;
    expect(resolveService).toHaveBeenCalledTimes(1);

    pending.value = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(disposeService).not.toHaveBeenCalled();

    pending.value = false;
    execSimctlMock.mockResolvedValue('{"devices":{}}');
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    expect(disposeService).toHaveBeenCalledTimes(1);
  });
});
