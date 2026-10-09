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

// Only the transport is faked, so the queue under test is the real one and the
// commands it serializes are the ones a device would receive.
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
    // The cleanup `rm -f` runs outside the queue by design; counting it here
    // would report an overlap the queue never promised to prevent.
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
    // `uitest` does not tolerate overlapping invocations: a second one launched
    // while the first is running blocks, and is SIGKILLed if that carries it
    // past the 20s timeout — measured as one 20s failure out of two concurrent
    // `dumpLayout`s. Two argent calls landing together take that loss on a race
    // the caller did not cause and cannot do anything about.
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
    // The queue is keyed per device precisely so a phone and an emulator, or two
    // emulators, still run at once. One global lock would serialize an agent's
    // whole fleet behind its slowest device.
    const a = harmonyScreenCap("dev-a", "/tmp/a.png");
    const b = harmonyScreenCap("dev-b", "/tmp/b.png");
    await settle();

    expect(events).toEqual(["start:dev-a", "start:dev-b"]);

    await releaseOne();
    await releaseOne();
    await Promise.all([a, b]);
  });

  it("lets the next call through after one that failed", async () => {
    // The queue tracks settlement, not the value. Chaining the successor onto
    // the rejection itself would strand every later call on that device behind
    // one `uitest` failure — with nothing to release it, since the failure has
    // already been reported to its own caller.
    // Two things this has to get right to exercise the chain at all. The failing
    // call must still be IN the queue when the next one joins it — one that
    // fails before the successor enqueues finds an empty queue. And the failure
    // must be the transport REJECTING: a `uitest` that merely exits non-zero
    // resolves the queued work and is thrown on afterwards, outside the queue,
    // so it never reaches the chain this test is about.
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
    // The map entry is dropped when the queue drains, and only then: the tail is
    // replaced on every enqueue, so a settled call deleting the entry
    // unconditionally would hand the next arrival an empty queue while the call
    // behind it is still on the device — two `uitest` processes at once, which
    // is the one thing the queue exists to prevent.
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
    // `uitest` exits non-zero for every on-device refusal there is — the harmony
    // tap, swipe, keyboard, screenshot and describe paths all reach the device
    // through this one check. Reading its status as success reports a tap that
    // never landed. It prints 12 lines of usage after the diagnostic, so only
    // the leading line is surfaced; the rest buries it in the agent's context.
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
    // The failure is thrown outside the queue, so the queued unit resolves — but
    // only if the throw really is outside it. Moved inside, every later call on
    // that device would chain onto a rejection with nothing to release it.
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

  // A `timeoutMs` accepted here and dropped leaves every clamp upstream —
  // boot-device's probe, the wait tools' polls — computing a bound nothing
  // enforces, which is the state this whole parameter exists to leave behind.
  // Both round trips count: the fetch is the half that hangs when a device
  // starts to go away, and it defaults to 30s, above every caller's budget.
  it("bounds the `uitest` call and the fetch that follows it", async () => {
    const RUN_MS = 200;
    const { shellTimeouts, fetchTimeouts } = deviceTakes(RUN_MS);

    await harmonyDumpLayout("dev-a", dumpPath("one"), 900);

    // Nothing ran before it, so the capture gets ~the whole budget…
    expect(shellTimeouts).toHaveLength(1);
    expect(shellTimeouts[0]).toBeGreaterThan(800);
    expect(shellTimeouts[0]).toBeLessThanOrEqual(900);
    // …and the fetch gets what the capture left, rather than a sliver above zero
    // or a fresh 30s default.
    expect(fetchTimeouts).toHaveLength(1);
    // Half a run of tolerance, not the millisecond: `setTimeout` can fire a
    // touch early. What has to discriminate is a fetch handed the full budget.
    expect(fetchTimeouts[0]).toBeLessThan(900 - RUN_MS / 2);
    expect(fetchTimeouts[0]).toBeGreaterThan(900 - RUN_MS - 150);
  });

  it("charges the wait for another caller's `uitest` to the budget, not to the fetch alone", async () => {
    // Two callers on one device, each with the same budget. The second waits out
    // the first in `enqueueUitest` — time nothing was charging — and then, if the
    // capture is handed a fresh full ceiling, spends the whole budget on the
    // capture and leaves the fetch a 1ms SIGKILL reported as a device that hung,
    // with the capture still sitting on the device.
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

    // The queued caller's capture is bounded by what its budget had left after
    // the wait, not by the budget it started with.
    expect(shellTimeouts).toHaveLength(2);
    // Half a run of tolerance — see the note on the previous case.
    expect(shellTimeouts[1]).toBeLessThan(BUDGET_MS - RUN_MS / 2);
    // And once that is spent, the fetch is not attempted at all: the caller is
    // told the budget ran out instead of being handed a killed transfer.
    expect(fetchTimeouts).toHaveLength(1);
    expect(getFailureSignal(outcome)).toMatchObject({
      error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
      failure_stage: "harmony_budget_exhausted",
      error_kind: "timeout",
    });
    expect(outcome?.message).toContain("Ran out of time");
  });

  it("bounds the cleanup delete, which runs after the budget is spent", async () => {
    // The delete is deliberately outside the shared budget — a spent budget is
    // no reason to leave a multi-hundred-KB capture on the device — but on
    // `runHdcShell`'s 30s default a wedged daemon adds 30s to a call whose
    // caller has already run out of time, on top of every ceiling before it.
    const rmTimeouts: (number | undefined)[] = [];
    runHdcShell.mockImplementation(async (_key, command, timeoutMs) => {
      if (command.startsWith("rm -f ")) rmTimeouts.push(timeoutMs);
      return { stdout: "", exitCode: 0 };
    });
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      writeFileSync(localPath, "{}");
    });

    await harmonyDumpLayout("dev-a", dumpPath("cleanup"), 900);

    // Sized against the 0.1-0.8s an `hdc shell` round trip was measured at, and
    // well under the MCP client's 30s abort.
    expect(rmTimeouts).toEqual([5_000]);
  });

  it("reads the display on a ceiling small enough to leave the injection its budget", async () => {
    // Every gesture backend calls this with no budget of its own, so the default
    // is the whole bound on the read — and the read is the first of two legs
    // inside ONE interaction ceiling. Left on `uitest`'s 20s the render service
    // alone could spend the entire interaction budget, leaving the injection it
    // was read for nothing to run in; the tool would then fail on a step that
    // never touched the screen. Sized off a measured 50-190ms read.
    const displayTimeouts: (number | undefined)[] = [];
    runHdcShell.mockImplementation(async (_key, command, timeoutMs) => {
      displayTimeouts.push(timeoutMs);
      // The measured line shape: one `screen[N]:` per panel, carrying the power
      // state and the size together (see harmony-display.test.ts).
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
