/**
 * The stall watch of `shutdownChild`: during the SIGINT window it polls a
 * progress probe, and a child whose progress fingerprint stays the same for
 * `idleMs` is taken as hung, so the ladder goes on to SIGTERM early. A probe
 * that cannot tell (null, or a throw) never counts as a hang. Below it, the
 * probe that native-profiler-stop uses for xctrace, tested through
 * its contract against real processes and files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shutdownChild } from "../../src/utils/profiler-shared/lifecycle";
import { xctraceProgressProbe } from "../../src/utils/ios-profiler/xctrace-progress";

/** A stub `ps` for the probe to run in place of the system one, while set. */
const psStub = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../../src/utils/vega-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/vega-process")>();
  return {
    ...actual,
    get PS_BIN() {
      return psStub.path ?? actual.PS_BIN;
    },
  };
});

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

// Each test spawns real processes, waits up to 0.8 s and runs `ps` twice with
// its 2 s timeout: up to about 5 s, the default test timeout. On a busy Mac,
// one took 24 s.
describe("xctraceProgressProbe", { timeout: 30_000 }, () => {
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

  /** Before xctrace has said that it stops, unless `stopping`. */
  const probeOptions = (idleMs = IDLE_MS, stopping = false) => ({
    idleMs,
    stopping: () => stopping,
  });

  /** Past the start of the process, whose own CPU time could still move. */
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it("stays the same while the process uses no CPU and the trace does not grow", async () => {
    const probe = xctraceProgressProbe(run("sleep", ["30"]), dir, probeOptions());
    await settle();
    const first = await probe();
    await new Promise((r) => setTimeout(r, 300));
    expect(first).not.toBeNull();
    expect(await probe()).toBe(first);
  });

  it("changes when the trace grows, also in a nested file", async () => {
    const probe = xctraceProgressProbe(run("sleep", ["30"]), dir, probeOptions());
    await settle();
    const before = await probe();

    appendFileSync(join(dir, "Trace1.run", "data"), "more bytes");

    expect(await probe()).not.toBe(before);
  });

  // A tool-server that a GUI app or launchd started has a PATH without /bin, where ps is.
  it("reads the CPU time also when no ps is on PATH", async () => {
    const sleeping = run("sleep", ["30"]);
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await unreadable(xctraceProgressProbe(sleeping, dir, probeOptions()))).not.toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
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
      // A 5 s idle limit: 0.05 s of CPU counts.
      const probe = xctraceProgressProbe(busy, dir, probeOptions(5_000));
      await new Promise((r) => setTimeout(r, 300));
      const before = await probe();
      await new Promise((r) => setTimeout(r, 500));

      expect(await probe()).not.toBe(before);
    }
  );

  describe("with the CPU times of an xctrace that hangs in its run loop", () => {
    let bin = "";
    /** What the stub `ps` prints, as `ps -o time=` does. */
    const cpuTime = (time: string) => writeFileSync(join(bin, "time"), `  ${time}\n`);

    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), "argent-xctrace-ps-"));
      writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat "${join(bin, "time")}"\n`, { mode: 0o755 });
      psStub.path = join(bin, "ps");
    });
    afterEach(() => {
      psStub.path = undefined;
      rmSync(bin, { recursive: true, force: true });
    });

    it("does not count a little CPU time as progress", async () => {
      const probe = xctraceProgressProbe(run("sleep", ["30"]), dir, probeOptions());
      cpuTime("0:03.83");
      const first = await probe();

      // As measured: 3.83 s to 4.19 s of CPU time in 2.5 min, with nothing written.
      for (const time of ["0:03.84", "0:03.90", "0:04.05", "0:04.12"]) {
        cpuTime(time);
        expect(await probe()).toBe(first);
      }
      // 1 % of a core over the 30 s idle limit: 0.3 s.
      cpuTime("0:04.19");
      const busy = await probe();
      expect(busy).not.toBe(first);
      cpuTime("0:04.30");
      expect(await probe()).toBe(busy);
    });

    it("counts the CPU time from the last change of the trace", async () => {
      const probe = xctraceProgressProbe(run("sleep", ["30"]), dir, probeOptions());
      cpuTime("0:03.83");
      await probe();
      cpuTime("0:04.05");
      appendFileSync(join(dir, "Trace1.run", "data"), "more bytes");
      const grown = await probe();

      cpuTime("0:04.30");
      expect(await probe()).toBe(grown);
      cpuTime("1:00:04.35");
      expect(await probe()).not.toBe(grown);
    });

    it("counts any CPU time once xctrace says that it stops", async () => {
      let stopping = false;
      const probe = xctraceProgressProbe(run("sleep", ["30"]), dir, {
        idleMs: IDLE_MS,
        stopping: () => stopping,
      });
      cpuTime("0:03.83");
      const first = await probe();
      cpuTime("0:03.84");
      expect(await probe()).toBe(first);

      stopping = true;
      expect(await probe()).not.toBe(first);
    });
  });

  it("gives no fingerprint for a process that is gone or a trace that is missing", async () => {
    const gone = run("sleep", ["30"]);
    const exited = new Promise((r) => gone.once("exit", r));
    gone.kill("SIGKILL");
    await exited;
    expect(await unreadable(xctraceProgressProbe(gone, dir, probeOptions()))).toBeNull();

    const live = run("sleep", ["30"]);
    expect(
      await unreadable(xctraceProgressProbe(live, join(dir, "missing.trace"), probeOptions()))
    ).toBeNull();

    const neverStarted = { pid: undefined } as unknown as ChildProcess;
    expect(await xctraceProgressProbe(neverStarted, dir, probeOptions())()).toBeNull();
  });
});
