/**
 * Issue #1494: a `simctl list` that never answers must not pile up one call per
 * tick, and must not hold the watcher's `ready` (and so the server's listen)
 * forever.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const execSimctlMock = vi.fn();

vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return { ...actual, execSimctl: (...args: unknown[]) => execSimctlMock(...args) };
});

const additionalSets: string[] = [];

vi.mock("../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-device-sets")>(
    "../src/utils/ios-device-sets"
  );
  return { ...actual, configuredAdditionalDeviceSets: () => additionalSets };
});

import * as os from "node:os";
import type { Registry } from "@argent/registry";
import { SimctlTimeoutError } from "../src/utils/simctl-exec";
import { startSimulatorWatcher } from "../src/utils/simulator-watcher";

const registry = {
  resolveService: vi.fn(),
  disposeService: vi.fn(async () => {}),
} as unknown as Registry;

let stderrWrites: string[];

beforeEach(() => {
  execSimctlMock.mockReset();
  additionalSets.length = 0;
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

describe("simulator-watcher with a hung simctl", () => {
  it("keeps one call in flight while simctl does not answer", async () => {
    let finish: (stdout: string) => void = () => {};
    execSimctlMock
      .mockResolvedValueOnce('{"devices":{}}')
      .mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(2);

    // Once it answers, the next tick polls again.
    finish('{"devices":{}}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSimctlMock).toHaveBeenCalledTimes(3);
    stop();
  });

  it("lets ready resolve when the first call times out, and says why once", async () => {
    execSimctlMock.mockRejectedValue(
      new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000)
    );

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    const hints = stderrWrites.filter((w) => w.includes("xcodebuild -runFirstLaunch"));
    expect(hints).toHaveLength(1);
  });

  it("logs the hint again after simctl recovers and hangs anew", async () => {
    const timeout = new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);
    execSimctlMock
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce('{"devices":{}}')
      .mockRejectedValue(timeout);

    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    const hints = stderrWrites.filter((w) => w.includes("xcodebuild -runFirstLaunch"));
    expect(hints).toHaveLength(2);
  });

  it("backs off while simctl keeps timing out, and resumes the interval once it answers", async () => {
    const callTimes: number[] = [];
    let hung = true;
    execSimctlMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (hung) throw new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000);
      return '{"devices":{}}';
    });

    const start = Date.now();
    const { ready, stop } = startSimulatorWatcher(registry);
    await ready;
    await vi.advanceTimersByTimeAsync(600_000);
    // Gaps of 20 s, 40 s, 80 s, 160 s, then capped at 300 s.
    expect(callTimes.map((t) => t - start)).toEqual([0, 20_000, 60_000, 140_000, 300_000, 600_000]);

    hung = false;
    callTimes.length = 0;
    await vi.advanceTimersByTimeAsync(330_000);
    const afterRecovery = callTimes.map((t) => t - start);
    // The call at 900 s answers; from there the plain 10 s interval applies.
    expect(afterRecovery.slice(0, 3)).toEqual([900_000, 910_000, 920_000]);
    stop();
  });

  it("waits for every device set, and backs off when any of them timed out", async () => {
    additionalSets.push(os.tmpdir());
    // The default set fails fast, so its error comes first; the timeout must still win.
    let finishExtraSet: (err: Error) => void = () => {};
    execSimctlMock.mockImplementation((args: string[]) => {
      if (!args.includes("--set")) return Promise.reject(new Error("exit 1"));
      return new Promise<string>((_, reject) => (finishExtraSet = reject));
    });

    const { ready, stop } = startSimulatorWatcher(registry);
    let settled = false;
    void ready.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    finishExtraSet(new SimctlTimeoutError(["simctl", "list", "devices", "--json"], 10_000));
    await ready;
    expect(stderrWrites.filter((w) => w.includes("xcodebuild -runFirstLaunch"))).toHaveLength(1);
    stop();
  });

  it("aborts the in-flight call on stop", async () => {
    let signal: AbortSignal | undefined;
    execSimctlMock.mockImplementation((_args: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<string>(() => {});
    });

    const { stop } = startSimulatorWatcher(registry);
    expect(signal?.aborted).toBe(false);
    stop();
    expect(signal?.aborted).toBe(true);
  });
});
