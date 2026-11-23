/**
 * A hang whose main thread only waited (a sleep, a lock, I/O) can hold the few
 * samples of argent's library that ran in it, such as the click that argent
 * delivers on the main thread. The report marked them "argent's own library",
 * named one as the hang's likely cause, and its CPU note said that such a hang
 * "was caused by that tool, not the app". So an agent dismissed a real 2 s hang
 * of the app as argent's work. Now a hang whose main thread ran for less than
 * 10% of it says that the main thread very possibly waited, and names no cause.
 */
import { describe, expect, it } from "vitest";
import { correlateHangsWithCpu } from "../../src/utils/ios-profiler/pipeline/01-correlate";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type { CpuSample, RawHang, StackFrame } from "../../src/utils/ios-profiler/types";

const MAIN = "Main Thread 0x7f11ae9 (BlockFix, pid: 94531)";
const WORKER = "BlockFix 0x7f15dd8 (BlockFix, pid: 94531)";
const MS = 1_000_000;

const app = (name: string): StackFrame => ({ name, isSystemLibrary: false });
const system = (name: string): StackFrame => ({ name, isSystemLibrary: true });
const argent = (name: string): StackFrame => ({ name, isSystemLibrary: false, tooling: "argent" });

function samples(count: number, startMs: number, stack: StackFrame[], thread = MAIN): CpuSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestampNs: (startMs + i) * MS,
    threadFmt: thread,
    weightNs: MS,
    stack,
  }));
}

/** A 2 s Severe Hang of the main thread at 10 s, in the format of Instruments' hangs. */
const HANG: RawHang = {
  startNs: 10_000 * MS,
  durationNs: 2_000 * MS,
  hangType: "Severe Hang",
  threadFmt: "Main Thread (0x7f11ae9) (BlockFix, pid: 94531)",
};

const CLICK = [argent("__MacRegisterInputMethods_block_invoke"), app("main")];
/** The main thread's work before the hang: how its name shows in the samples. */
const EARLIER = samples(20, 5_000, [system("objc_msgSend"), app("main")]);

async function report(hangSamples: CpuSample[], suspendedNs?: number[]): Promise<string> {
  const { uiHangs } = correlateHangsWithCpu([HANG], [...EARLIER, ...hangSamples], suspendedNs);
  const rendered = await renderNativeProfilerReport({
    payload: {
      metadata: { traceFile: null, platform: "macOS", timestamp: "2026-11-17T00:00:00Z" },
      bottlenecks: uiHangs,
    },
    traceFile: null,
  });
  return rendered.report;
}

describe("a hang whose main thread waited, with argent's work in it", () => {
  it("says that the main thread very possibly waited, and names no cause", async () => {
    // The click that started a 2 s sleep, and one sample at its end: 2 ms of 2000.
    const hangSamples = [
      ...samples(1, 10_001, CLICK),
      ...samples(1, 11_990, [system("objc_msgSend"), app("main")]),
    ];
    const { uiHangs } = correlateHangsWithCpu([HANG], [...EARLIER, ...hangSamples]);
    expect(uiHangs[0]!.hangThreadRanMs).toBe(2);

    const text = await report(hangSamples);
    expect(text).toContain(
      "The main thread ran for only 2 ms of this hang, so it very possibly waited, for " +
        "example in a sleep, for a lock, for I/O or for another thread."
    );
    expect(text).toContain("__MacRegisterInputMethods_block_invoke (argent's own library)");
    expect(text).not.toContain("Likely caused by");
  });

  it("counts argent's work on another thread as no run of the main thread", async () => {
    // A tree read of describe on a worker thread for the whole hang.
    const hangSamples = samples(1_900, 10_050, [argent("MacAXCopy")], WORKER);
    const text = await report(hangSamples);
    expect(text).toContain("The main thread ran for only 0 ms of this hang");
    expect(text).not.toContain("Likely caused by");
  });

  it("still names argent's work as the cause when it ran on the main thread", async () => {
    // describe ran on the main thread for 1.5 s of the hang.
    const hangSamples = samples(1_500, 10_100, [
      argent("-[ARGDescribe snapshotTree]"),
      app("main"),
    ]);
    const { uiHangs } = correlateHangsWithCpu([HANG], [...EARLIER, ...hangSamples]);
    expect(uiHangs[0]).not.toHaveProperty("hangThreadRanMs");

    const text = await report(hangSamples);
    expect(text).toContain(
      "Likely caused by: `-[ARGDescribe snapshotTree] (argent's own library)`."
    );
    expect(text).not.toContain("very possibly waited");
  });

  it("leaves the time when the app was suspended out of the hang's length", async () => {
    // 30 ms of run: less than 10% of 2000 ms, but not of the 200 ms that were not suspended.
    const hangSamples = samples(30, 10_001, CLICK);
    const waited = correlateHangsWithCpu([HANG], [...EARLIER, ...hangSamples]);
    expect(waited.uiHangs[0]!.hangThreadRanMs).toBe(30);
    const suspended = correlateHangsWithCpu([HANG], [...EARLIER, ...hangSamples], [1_800 * MS]);
    expect(suspended.uiHangs[0]).not.toHaveProperty("hangThreadRanMs");
  });

  it("does not say it waited when the hang's thread has no sample in the trace", async () => {
    // The hang's thread name matches no sample, so how long it ran is not known.
    const { uiHangs } = correlateHangsWithCpu(
      [{ ...HANG, threadFmt: "Thread 0x99 (BlockFix, pid: 94531)" }],
      [...EARLIER, ...samples(1, 10_001, CLICK)]
    );
    expect(uiHangs[0]).not.toHaveProperty("hangThreadRanMs");
  });

  it("keeps the report of a waited hang with no tool's work as it was", async () => {
    const hangSamples = samples(2, 10_001, [system("objc_msgSend"), app("-[Fixture blockMain]")]);
    const text = await report(hangSamples);
    expect(text).toContain("Likely caused by: `-[Fixture blockMain]`.");
    expect(text).not.toContain("very possibly waited");
  });
});
