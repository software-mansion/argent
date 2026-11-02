import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  hdcFileRecv as realHdcFileRecv,
  runHdcShell as realRunHdcShell,
} from "../src/utils/harmony-hdc";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  harmonyDisplay,
  harmonyDumpLayout,
  harmonyScreenCap,
} from "../src/utils/harmony-uitest";

vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn(), hdcFileRecv: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);
const hdcFileRecv = vi.mocked(realHdcFileRecv);

/** `start`/`end` per `uitest` call, in the order the device would see them. */
let events: string[] = [];
/** Resolvers for the `uitest` calls currently blocked, in start order. */
let blocked: (() => void)[] = [];

/** Let every microtask that can run, run — without releasing any device call. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  events = [];
  blocked = [];
  hdcFileRecv.mockResolvedValue(undefined);
  runHdcShell.mockImplementation(async (key, command) => {
    // The cleanup `rm -f` runs outside the queue by design.
    if (!command.startsWith("uitest ")) return { stdout: "", exitCode: 0 };
    events.push(`start:${key}`);
    await new Promise<void>((resolve) => blocked.push(resolve));
    events.push(`end:${key}`);
    return { stdout: "", exitCode: 0 };
  });
});

/** Release the longest-blocked `uitest` call and let the queue advance. */
async function releaseOne(): Promise<void> {
  blocked.shift()?.();
  await settle();
}

describe("the per-device uitest queue", () => {
  it("holds a second call on one device until the first has finished", async () => {
    // Overlapping `uitest` invocations block each other into SIGKILL.
    const first = harmonyScreenCap("dev-a", "/tmp/a.png");
    const second = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();

    expect(events).toEqual(["start:dev-a"]);

    await releaseOne();
    expect(events).toEqual(["start:dev-a", "end:dev-a", "start:dev-a"]);

    await releaseOne();
    await Promise.all([first, second]);
  });

  it("does not hold one device's call behind another device's", async () => {
    const a = harmonyScreenCap("dev-a", "/tmp/a.png");
    const b = harmonyScreenCap("dev-b", "/tmp/b.png");
    await settle();

    expect(events).toEqual(["start:dev-a", "start:dev-b"]);

    await releaseOne();
    await releaseOne();
    await Promise.all([a, b]);
  });

  it("lets the next call through after one that failed", async () => {
    // The failing call must still be queued when the next joins, and must
    // reject (a non-zero exit resolves the queued work and throws after it).
    runHdcShell.mockImplementationOnce(async (key, command) => {
      events.push(`start:${key}`);
      expect(command).toContain("uitest");
      await new Promise<void>((resolve) => blocked.push(resolve));
      throw new Error("hdc could not reach HarmonyOS device 'dev-a'");
    });

    const failed = harmonyScreenCap("dev-a", "/tmp/a.png");
    await settle();
    const next = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();
    expect(events).toEqual(["start:dev-a"]);

    blocked.shift()?.();
    await expect(failed).rejects.toThrow(/could not reach/);
    await settle();
    expect(events).toEqual(["start:dev-a", "start:dev-a"]);

    await releaseOne();
    await expect(next).resolves.toBeUndefined();
  });

  it("keeps serializing when a call joins a queue whose head has already finished", async () => {
    const first = harmonyScreenCap("dev-a", "/tmp/a.png");
    await settle();
    const second = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();

    await releaseOne(); // `first` settles; `second` is now the one on the device
    expect(events).toEqual(["start:dev-a", "end:dev-a", "start:dev-a"]);

    const third = harmonyScreenCap("dev-a", "/tmp/c.png");
    await settle();
    expect(events).toEqual(["start:dev-a", "end:dev-a", "start:dev-a"]);

    await releaseOne();
    await releaseOne();
    await Promise.all([first, second, third]);
  });

  it("reports a `uitest` that ran and failed, without its usage block", async () => {
    runHdcShell.mockResolvedValueOnce({
      stdout: "error: no such file or directory\nusage: uitest screenCap -p <path>\n  -p path",
      exitCode: 1,
    });

    const err = await harmonyScreenCap("dev-a", "/tmp/a.png").then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
      failure_command: "hdc",
    });
    expect(err?.message).toContain("error: no such file or directory");
    expect(err?.message).not.toContain("usage:");
  });

  it("lets the next call through after a `uitest` that exited non-zero", async () => {
    runHdcShell.mockResolvedValueOnce({ stdout: "error: device is asleep", exitCode: 1 });

    await expect(harmonyScreenCap("dev-a", "/tmp/a.png")).rejects.toThrow(/device is asleep/);

    const next = harmonyScreenCap("dev-a", "/tmp/b.png");
    await settle();
    expect(events).toEqual(["start:dev-a"]);
    await releaseOne();
    await expect(next).resolves.toBeUndefined();
  });
});

describe("a caller's own ceiling reaches the device", () => {
  const dumpPath = (tag: string) =>
    join(tmpdir(), `argent-uitest-budget-${process.pid}-${tag}.json`);

  /** Serve a `uitest` call that takes `runMs`, recording the ceiling it was given. */
  function deviceTakes(runMs: number): {
    shellTimeouts: (number | undefined)[];
    fetchTimeouts: (number | undefined)[];
  } {
    const shellTimeouts: (number | undefined)[] = [];
    const fetchTimeouts: (number | undefined)[] = [];
    runHdcShell.mockImplementation(async (_key, command, timeoutMs) => {
      if (!command.startsWith("uitest ")) return { stdout: "", exitCode: 0 };
      shellTimeouts.push(timeoutMs);
      await new Promise((r) => setTimeout(r, runMs));
      return { stdout: "", exitCode: 0 };
    });
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath, timeoutMs) => {
      fetchTimeouts.push(timeoutMs);
      writeFileSync(localPath, "{}");
    });
    return { shellTimeouts, fetchTimeouts };
  }

  it("bounds the `uitest` call and the fetch that follows it", async () => {
    const RUN_MS = 200;
    const { shellTimeouts, fetchTimeouts } = deviceTakes(RUN_MS);

    await harmonyDumpLayout("dev-a", dumpPath("one"), 900);

    // Nothing ran before it, so the capture gets ~the whole budget…
    expect(shellTimeouts).toHaveLength(1);
    expect(shellTimeouts[0]).toBeGreaterThan(800);
    expect(shellTimeouts[0]).toBeLessThanOrEqual(900);
    expect(fetchTimeouts).toHaveLength(1);
    // Half a run of tolerance: `setTimeout` can fire early.
    expect(fetchTimeouts[0]).toBeLessThan(900 - RUN_MS / 2);
    expect(fetchTimeouts[0]).toBeGreaterThan(900 - RUN_MS - 150);
  });

  it("charges the wait for another caller's `uitest` to the budget, not to the fetch alone", async () => {
    // The second caller's wait in the queue counts against its budget.
    const BUDGET_MS = 500;
    const RUN_MS = 300;
    const { shellTimeouts, fetchTimeouts } = deviceTakes(RUN_MS);

    const first = harmonyDumpLayout("dev-a", dumpPath("first"), BUDGET_MS);
    const second = harmonyDumpLayout("dev-a", dumpPath("second"), BUDGET_MS);

    await expect(first).resolves.toEqual({});
    const outcome = await second.then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(shellTimeouts).toHaveLength(2);
    // Half a run of tolerance.
    expect(shellTimeouts[1]).toBeLessThan(BUDGET_MS - RUN_MS / 2);
    expect(fetchTimeouts).toHaveLength(1);
    expect(getFailureSignal(outcome)).toMatchObject({
      error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
      failure_stage: "harmony_budget_exhausted",
      error_kind: "timeout",
    });
    expect(outcome?.message).toContain("Ran out of time");
  });

  it("bounds the cleanup delete, which runs after the budget is spent", async () => {
    const rmTimeouts: (number | undefined)[] = [];
    runHdcShell.mockImplementation(async (_key, command, timeoutMs) => {
      if (command.startsWith("rm -f ")) rmTimeouts.push(timeoutMs);
      return { stdout: "", exitCode: 0 };
    });
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      writeFileSync(localPath, "{}");
    });

    await harmonyDumpLayout("dev-a", dumpPath("cleanup"), 900);

    expect(rmTimeouts).toEqual([5_000]);
  });

  it("reads the display on a ceiling small enough to leave the injection its budget", async () => {
    // The read and its injection share one interaction ceiling.
    const displayTimeouts: (number | undefined)[] = [];
    runHdcShell.mockImplementation(async (_key, command, timeoutMs) => {
      displayTimeouts.push(timeoutMs);
      return {
        stdout:
          "-- ScreenInfo\nscreen[0]: id=0, powerStatus=POWER_STATUS_ON, backlight=1, " +
          "render resolution=1320x2856, physical resolution=1320x2856\n",
        exitCode: 0,
      };
    });

    await expect(harmonyDisplay("dev-a")).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });

    expect(displayTimeouts).toEqual([5_000]);
    expect(displayTimeouts[0]!).toBeLessThan(HARMONY_INTERACTION_TIMEOUT_MS);
  });
});
