import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  iosInstrumentsSessionBlueprint,
  type IosProfilerSessionApi,
} from "../../src/blueprints/ios-profiler-session";

// Minimal ChildProcess fake — same shape as the lifecycle tests.
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  respondsTo: Set<NodeJS.Signals> = new Set();
  respondAfterMs = 0;
  signalLog: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalLog.push(signal);
    if (this.respondsTo.has(signal) && this.exitCode === null && this.signalCode === null) {
      setTimeout(() => this.exitWith(signal), this.respondAfterMs);
    }
    return true;
  }

  exitWith(signal: NodeJS.Signals | null): void {
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

async function buildSession(): Promise<{
  api: IosProfilerSessionApi;
  dispose: () => Promise<void>;
}> {
  const instance = await iosInstrumentsSessionBlueprint.factory({}, "DEVICE-UDID");
  return { api: instance.api, dispose: instance.dispose };
}

describe("iosInstrumentsSessionBlueprint dispose", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is a no-op when no recording is active", async () => {
    const { dispose } = await buildSession();
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("clears the 10-min recording timer even with no live xctrace", async () => {
    const { api, dispose } = await buildSession();
    const onFire = vi.fn();
    api.recordingTimeout = setTimeout(onFire, 60_000);
    await dispose();
    expect(api.recordingTimeout).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("SIGKILLs xctrace immediately rather than running the SIGINT grace ladder", async () => {
    const { api, dispose } = await buildSession();
    const child = new FakeChild();
    child.respondsTo = new Set<NodeJS.Signals>(["SIGKILL"]);
    child.respondAfterMs = 1;
    api.profilingActive = true;
    api.xctracePid = 1234;
    api.xctraceProcess = asChild(child);

    const promise = dispose();
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(child.signalLog).toEqual(["SIGKILL"]);
    expect(api.profilingActive).toBe(false);
    expect(api.xctracePid).toBeNull();
    expect(api.xctraceProcess).toBeNull();
  });

  it("returns within the reap window even if SIGKILL never reaps the handle", async () => {
    const { api, dispose } = await buildSession();
    const child = new FakeChild();
    // respondsTo is empty — the fake never emits 'exit'. Real OS kernels reap
    // SIGKILL targets near-instantly; this scenario asserts dispose still
    // unblocks if for any reason 'exit' never fires.
    api.profilingActive = true;
    api.xctracePid = 1234;
    api.xctraceProcess = asChild(child);

    const promise = dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(child.signalLog).toEqual(["SIGKILL"]);
    expect(api.profilingActive).toBe(false);
    expect(api.xctracePid).toBeNull();
    expect(api.xctraceProcess).toBeNull();
  });

  it("survives kill() throwing on an already-dead handle", async () => {
    const { api, dispose } = await buildSession();
    const child = new FakeChild();
    child.kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    child.exitCode = 0;
    api.profilingActive = true;
    api.xctracePid = 1234;
    api.xctraceProcess = asChild(child);

    await expect(dispose()).resolves.toBeUndefined();
    expect(api.profilingActive).toBe(false);
  });
});
