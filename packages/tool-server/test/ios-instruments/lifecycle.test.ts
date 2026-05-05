import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { waitForChildExit, shutdownChild } from "../../src/utils/ios-profiler/lifecycle";

// A minimal fake of ChildProcess that supports the surface lifecycle.ts uses:
// `exitCode`, `signalCode`, `kill(signal)`, and the `'exit'` event.
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Signals that, when received, cause the fake to "exit" after `respondAfterMs`. */
  respondsTo: Set<NodeJS.Signals> = new Set();
  /** Latency between receiving a respected signal and emitting `'exit'`. */
  respondAfterMs = 0;
  /** Recorded log of every signal sent through `kill()`. */
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

  exitClean(): void {
    this.exitCode = 0;
    this.signalCode = null;
    this.emit("exit", 0, null);
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

describe("waitForChildExit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves true synchronously when child has already exited", async () => {
    const child = new FakeChild();
    child.exitClean();
    await expect(waitForChildExit(asChild(child), 1000)).resolves.toBe(true);
  });

  it("resolves true synchronously when child was killed by signal", async () => {
    const child = new FakeChild();
    child.exitWith("SIGKILL");
    await expect(waitForChildExit(asChild(child), 1000)).resolves.toBe(true);
  });

  it("resolves true when child exits before the deadline", async () => {
    const child = new FakeChild();
    const promise = waitForChildExit(asChild(child), 1000);
    setTimeout(() => child.exitClean(), 200);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when the deadline expires first", async () => {
    const child = new FakeChild();
    const promise = waitForChildExit(asChild(child), 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(false);
  });

  it("clears the deadline timer once the child exits", async () => {
    const child = new FakeChild();
    const promise = waitForChildExit(asChild(child), 5000);
    setTimeout(() => child.exitClean(), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toBe(true);
    // No pending timers after early exit (deadline was cleared).
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shutdownChild", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TIMINGS = { graceMs: 30_000, termMs: 5_000, killMs: 5_000 };

  it("returns clean=SIGINT immediately when child is already dead", async () => {
    const child = new FakeChild();
    child.exitClean();
    const result = await shutdownChild(asChild(child), TIMINGS);
    expect(result).toEqual({ clean: true, signalUsed: "SIGINT" });
    expect(child.signalLog).toEqual([]);
  });

  it("returns clean=SIGINT when SIGINT is sufficient", async () => {
    const child = new FakeChild();
    child.respondsTo = new Set<NodeJS.Signals>(["SIGINT"]);
    child.respondAfterMs = 100;
    const promise = shutdownChild(asChild(child), TIMINGS);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toEqual({ clean: true, signalUsed: "SIGINT" });
    expect(child.signalLog).toEqual(["SIGINT"]);
  });

  it("escalates to SIGTERM when SIGINT is ignored", async () => {
    const child = new FakeChild();
    child.respondsTo = new Set<NodeJS.Signals>(["SIGTERM"]);
    child.respondAfterMs = 50;
    const promise = shutdownChild(asChild(child), TIMINGS);
    // SIGINT window expires (30s), then SIGTERM is sent and lands.
    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual({ clean: false, signalUsed: "SIGTERM" });
    expect(child.signalLog).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGINT and SIGTERM are ignored", async () => {
    const child = new FakeChild();
    child.respondsTo = new Set<NodeJS.Signals>(["SIGKILL"]);
    child.respondAfterMs = 1;
    const promise = shutdownChild(asChild(child), TIMINGS);
    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs);
    await vi.advanceTimersByTimeAsync(TIMINGS.termMs);
    await vi.advanceTimersByTimeAsync(child.respondAfterMs);
    await expect(promise).resolves.toEqual({ clean: false, signalUsed: "SIGKILL" });
    expect(child.signalLog).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("returns SIGKILL even if the child never responds at all", async () => {
    const child = new FakeChild();
    // respondsTo is empty → child ignores every signal
    const promise = shutdownChild(asChild(child), TIMINGS);
    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs);
    await vi.advanceTimersByTimeAsync(TIMINGS.termMs);
    await vi.advanceTimersByTimeAsync(TIMINGS.killMs);
    await expect(promise).resolves.toEqual({ clean: false, signalUsed: "SIGKILL" });
    expect(child.signalLog).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("survives kill() throwing (already-dead races)", async () => {
    const child = new FakeChild();
    child.kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    const promise = shutdownChild(asChild(child), TIMINGS);
    // No signal landed; deadline expires through every stage.
    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs);
    await vi.advanceTimersByTimeAsync(TIMINGS.termMs);
    await vi.advanceTimersByTimeAsync(TIMINGS.killMs);
    await expect(promise).resolves.toEqual({ clean: false, signalUsed: "SIGKILL" });
  });
});
