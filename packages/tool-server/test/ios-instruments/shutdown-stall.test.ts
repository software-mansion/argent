/**
 * The stall watch of `shutdownChild`: during the SIGINT window it polls a
 * progress probe, and a child whose progress fingerprint stays the same for
 * `idleMs` is taken as hung, so the ladder goes on to SIGTERM early. A probe
 * that cannot tell (null, or a throw) never counts as a hang. Below it, the
 * probe that native-profiler-stop uses for a Mac app's xctrace, tested through
 * its contract against real processes and files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownChild } from "../../src/utils/profiler-shared/lifecycle";
import { xctraceProgressProbe } from "../../src/tools/profiler/native-profiler/platforms/xctrace";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Signals the fake exits on; it ignores the others. */
  respondsTo = new Set<NodeJS.Signals>();
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.respondsTo.has(signal)) queueMicrotask(() => this.exitWith(signal));
    return true;
  }

  exitWith(signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

const IDLE_MS = 30_000;
const POLL_MS = 2_000;
const TIMINGS = { graceMs: 300_000, termMs: 5_000, killMs: 5_000 };

describe("shutdownChild with a stall watch", () => {
  beforeEach(() => {
    // Date too: the SIGINT window and the idle clock read Date.now().
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stop(child: FakeChild, probe: () => Promise<string | null>) {
    return shutdownChild(asChild(child), {
      ...TIMINGS,
      stall: { probe, idleMs: IDLE_MS, pollMs: POLL_MS },
    });
  }

  it("ends the SIGINT window once the progress stays the same for idleMs, and says so", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");
    const probe = vi.fn(async () => "0:01.20|4096");

    const pending = stop(child, probe);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    // The same fingerprint since the first poll, but not yet for idleMs.
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    await expect(pending).resolves.toEqual({
      clean: false,
      signalUsed: "SIGTERM",
      stalled: true,
    });
    // Polled every pollMs, not continuously.
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(IDLE_MS / POLL_MS);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(IDLE_MS / POLL_MS + 2);
  });

  it("goes on to SIGKILL for a hung child that ignores SIGTERM too", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGKILL");

    const pending = stop(child, async () => "same");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 2 * POLL_MS + TIMINGS.termMs + TIMINGS.killMs);

    expect(child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    await expect(pending).resolves.toEqual({
      clean: false,
      signalUsed: "SIGKILL",
      stalled: true,
    });
  });

  it("restarts the idle clock whenever the progress changes", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");
    let progress = "a";
    const pending = stop(child, async () => progress);

    await vi.advanceTimersByTimeAsync(20_000);
    progress = "b";
    await vi.advanceTimersByTimeAsync(20_000);
    // 40 s after SIGINT, but only 20 s of the same progress.
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    await expect(pending).resolves.toMatchObject({ stalled: true });
  });

  it("waits the whole SIGINT window for a child that keeps making progress", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");
    let n = 0;
    const pending = stop(child, async () => `cpu-${n++}`);

    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs - POLL_MS);
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    // The ordinary escalation at the end of the window, not a stall.
    await expect(pending).resolves.toEqual({ clean: false, signalUsed: "SIGTERM" });
  });

  it.each([
    ["can not read the progress", async () => null],
    [
      "throws",
      async () => {
        throw new Error("ps: no such process");
      },
    ],
  ])("never takes a child as hung when the probe %s", async (_label, probe) => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");

    const pending = stop(child, probe);
    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs - POLL_MS);
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    await expect(pending).resolves.toEqual({ clean: false, signalUsed: "SIGTERM" });
  });

  it("an unreadable probe in between restarts the idle clock", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");
    let progress: string | null = "same";
    const pending = stop(child, async () => progress);

    await vi.advanceTimersByTimeAsync(20_000);
    progress = null;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    progress = "same";
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await expect(pending).resolves.toMatchObject({ stalled: true });
  });

  it("returns clean when the child exits on SIGINT while it is watched", async () => {
    const child = new FakeChild();
    const probe = vi.fn(async () => "same");
    const pending = stop(child, probe);

    await vi.advanceTimersByTimeAsync(5_000);
    child.exitWith("SIGINT");
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual({ clean: true, signalUsed: "SIGINT" });
    expect(child.signals).toEqual(["SIGINT"]);
    const polls = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(probe.mock.calls.length).toBe(polls);
  });

  it("without a stall watch, waits the whole SIGINT window for a child that does nothing", async () => {
    const child = new FakeChild();
    child.respondsTo.add("SIGTERM");
    const pending = shutdownChild(asChild(child), TIMINGS);

    await vi.advanceTimersByTimeAsync(IDLE_MS + 10 * POLL_MS);
    expect(child.signals).toEqual(["SIGINT"]);

    await vi.advanceTimersByTimeAsync(TIMINGS.graceMs);
    await expect(pending).resolves.toEqual({ clean: false, signalUsed: "SIGTERM" });
  });
});

describe("xctraceProgressProbe", () => {
  let dir = "";
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argent-xctrace-probe-"));
    mkdirSync(join(dir, "Trace1.run"), { recursive: true });
    writeFileSync(join(dir, "Trace1.run", "data"), "0123456789");
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  function run(command: string, args: string[]): ChildProcess {
    const child = spawn(command, args, { stdio: "ignore" });
    children.push(child);
    return child;
  }

  const unreadable = (probe: () => Promise<string | null>) => probe().catch(() => null);

  /** Past the start of the process, whose own CPU time could still move. */
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it("stays the same while the process uses no CPU and the trace does not grow", async () => {
    const probe = xctraceProgressProbe(run("sleep", ["30"]), dir);
    await settle();
    const first = await probe();
    await new Promise((r) => setTimeout(r, 300));
    expect(first).not.toBeNull();
    expect(await probe()).toBe(first);
  });

  it("changes when the trace grows, also in a nested file", async () => {
    const probe = xctraceProgressProbe(run("sleep", ["30"]), dir);
    await settle();
    const before = await probe();

    appendFileSync(join(dir, "Trace1.run", "data"), "more bytes");

    expect(await probe()).not.toBe(before);
  });

  // `ps -o time=` shows hundredths of a second on macOS, where xctrace runs;
  // Linux procps shows whole seconds.
  it.skipIf(process.platform !== "darwin")(
    "changes when the process uses CPU, with the trace unchanged",
    async () => {
      const busy = run(process.execPath, [
        "-e",
        "const end = Date.now() + 20000; while (Date.now() < end) {}",
      ]);
      const probe = xctraceProgressProbe(busy, dir);
      await new Promise((r) => setTimeout(r, 300));
      const before = await probe();
      await new Promise((r) => setTimeout(r, 500));

      expect(await probe()).not.toBe(before);
    }
  );

  it("gives no fingerprint for a process that is gone or a trace that is missing", async () => {
    const gone = run("sleep", ["30"]);
    const exited = new Promise((r) => gone.once("exit", r));
    gone.kill("SIGKILL");
    await exited;
    expect(await unreadable(xctraceProgressProbe(gone, dir))).toBeNull();

    const live = run("sleep", ["30"]);
    expect(await unreadable(xctraceProgressProbe(live, join(dir, "missing.trace")))).toBeNull();

    const neverStarted = { pid: undefined } as unknown as ChildProcess;
    expect(await xctraceProgressProbe(neverStarted, dir)()).toBeNull();
  });
});
