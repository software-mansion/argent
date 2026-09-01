import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// execute() probes the target's form factor (isTvOsSimulator) before polling —
// a real `xcrun simctl list` that never caches for this fake UDID, so it re-runs
// on every test and takes seconds under the parallel suite load. The device here
// is a plain phone shape, so pin the probe to false and keep the rest real.
vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});

// Android locked-device repro: the legacy uiautomator dump reports its failure
// as an in-band `ERROR:` line, which describeAndroid turns into a throwing
// FailureError — the hard, actionable error the tool must not launder into a
// latency diagnosis.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return {
    ...actual,
    isAndroidTv: async () => false,
    adbExecOutBinary: async () => Buffer.from("ERROR: could not get idle state.", "utf-8"),
  };
});
vi.mock("../src/utils/android-screen", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/android-screen")>(
    "../src/utils/android-screen"
  );
  return { ...actual, getAndroidScreenSize: async () => ({ width: 1080, height: 2400 }) };
});

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

// AX service that walks `responses` one per call, repeating the last — lets a
// test simulate a screen that is blank, then renders, then holds still.
function makeSequencedAXService(responses: AXDescribeResponse[]): AXServiceApi {
  let i = 0;
  return {
    degraded: false,
    describe: async () => responses[Math.min(i++, responses.length - 1)],
    alertCheck: async () => false,
    ping: async () => true,
  };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

function iosRegistry(ax: AXServiceApi) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return ax;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

const content = () => axResponse([{ label: "Settings", frame: FRAME, traits: ["button"] }]);

// A read that costs real time but a small fraction of the budget: the shape that
// separates "the tree was too slow" from "the schedule left no room". A describe
// resolving within a microtask cannot make that distinction visible.
function fastAx(readMs: number): AXServiceApi {
  return {
    degraded: false,
    describe: async () => {
      await new Promise((r) => setTimeout(r, readMs));
      return content();
    },
    alertCheck: async () => false,
    ping: async () => true,
  };
}

describe("await-screen-idle tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("exposes the await-screen-idle id", () => {
    expect(createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi)).id).toBe("await-screen-idle");
  });

  it("settles once content renders and holds still", async () => {
    // blank, then the same content on every later poll → stable
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([axResponse([]), content()]))
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
    expect(result.waitedMs).toBeLessThan(2000);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("does not settle while the screen stays blank (times out)", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([axResponse([])])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 60, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(60);
  });

  it("does not settle while content keeps changing (times out)", async () => {
    // a different label every poll never holds for minStableMs
    const changing = Array.from({ length: 30 }, (_, i) =>
      axResponse([{ label: `item-${i}`, frame: FRAME, traits: ["button"] }])
    );
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService(changing)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 80, pollIntervalMs: 5, minStableMs: 40 }
    );

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(80);
  });

  // A tree slow enough that the budget expires while a read is still in flight
  // never yields the second sample settling requires. Without the note, the
  // `settled: false` that comes back is indistinguishable from the
  // keeps-changing case above — it would assert the screen never went still
  // about a screen that was never sampled twice.
  it("reports a read that outran the budget rather than an unsettled screen", async () => {
    // Each read takes 200ms against a 300ms budget: poll 1 lands at ~200ms and
    // holds a signature, poll 2 starts at ~210ms with only ~90ms left and is
    // still in flight at the deadline.
    const slowAx: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return content();
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(slowAx));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("never sampled twice");
    expect(result.note).toContain("300ms");
  });

  // The other half of the same guarantee: a screen that really is churning must
  // still come back as a plain negative, or the note stops meaning anything.
  //
  // Every read here takes real time — because a describe that resolves within a
  // microtask is not a transport any device has — but a small enough share of
  // the budget that several more still fit after a slipped read on a loaded
  // runner. Two samples are what keeps the note off, so that margin is the test.
  it("omits the note when the screen genuinely keeps changing", async () => {
    let n = 0;
    const churning: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return axResponse([{ label: `item-${n++}`, frame: FRAME, traits: ["button"] }]);
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(churning));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 600, pollIntervalMs: 5, minStableMs: 500 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(1);
    expect(result.note).toBeUndefined();
  });

  // A hard, actionable device error (locked screen) must reach the agent as
  // itself. Every fetch throws on the Android legacy path here — the exact
  // locked-device trigger from review — so `samples` stays 0 and, without an
  // error guard, that lands in the same bucket as a tree too slow to read twice:
  // the note would tell the agent to raise timeoutMs, advice that cannot help
  // and hides the real cause.
  it("reports a failing tree fetch instead of a slow-read diagnosis", async () => {
    const tool = createAwaitScreenIdleTool({
      resolveService: vi.fn(async () => {
        throw new Error("no android-devtools helper");
      }),
    } as any);

    const result = await tool.execute(
      {},
      { udid: "emulator-5554", timeoutMs: 200, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toContain("last tree fetch failed:");
    expect(result.note).toContain("uiautomator could not capture");
  });

  // The other arm of the same guard. Here NO tree ever arrives — the first fetch
  // is still in flight at the deadline — which leaves `lastError` set to the
  // loop's own budget-expiry message. Reporting that as a failing fetch would
  // relabel the slowest possible read as a broken device, so the guard requires
  // `lastAttemptSettled` too. Dropping that clause flips this note.
  it("calls a first read the deadline cut off a slow read, not a failing fetch", async () => {
    const hangingAx: AXServiceApi = {
      degraded: false,
      describe: () => new Promise(() => {}),
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(hangingAx));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 120, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).not.toContain("last tree fetch failed");
    expect(result.note).toContain("did not finish within the 120ms budget");
    expect(result.note).toContain("Raise timeoutMs");
  });

  // `samples < 2` on its own does not mean the tree was slow: the same count
  // comes back when a `pollIntervalMs` wider than the remaining budget leaves no
  // room for a second read. Blaming timeoutMs there names a knob that is not the
  // problem — the read here uses a sixtieth of the budget.
  it("names pollIntervalMs when the interval, not the read, starved the second sample", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(15)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 900, pollIntervalMs: 2000, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBe(1);
    expect(result.note).toContain("pollIntervalMs (2000ms)");
    expect(result.note).toContain("never sampled twice");
    expect(result.note).not.toContain("outran the budget");
  });

  // The MCP auto-screenshot readiness wait passes timeoutMs 100 after `describe`
  // with the default interval, so the default path hits the same starve.
  it("names pollIntervalMs on the default interval when timeoutMs is small", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(5)));

    const result = await tool.execute({}, { udid: IOS_UDID, timeoutMs: 100 });

    expect(result.polls).toBe(1);
    expect(result.note).toContain("never sampled twice");
    // Whether the remedy is the interval or the budget depends on how long the
    // one read took, which a loaded runner decides; what must never come back is
    // the claim that reading the tree did not finish inside the budget.
    expect(result.note).not.toContain("outran the budget");
  });

  // The third starve, between the two above. Every fetch settles — so the
  // deadline cut nothing off — but the one read that landed took most of the
  // budget, and pollIntervalMs is already at the schema minimum. Naming the
  // sleep there points at a knob the caller cannot turn: a second read needs the
  // first one's length again, which no interval buys.
  it("names timeoutMs when one settled read leaves no room for a second at any interval", async () => {
    // 350ms of a 600ms budget: the clamped sleep reaches the deadline, so no
    // fetch is cut off, and yet a second read of that size could not have fitted
    // however short the sleep was made.
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(350)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 600, pollIntervalMs: 400, minStableMs: 100 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBe(1);
    expect(result.note).toContain("at any pollIntervalMs");
    expect(result.note).toContain("Raise timeoutMs");
    expect(result.note).not.toContain("pollIntervalMs (400ms)");
  });

  // A tree read many times over with nothing in it is not a screen that kept
  // changing. Which of the two reasons it is — nothing rendered, or the reader
  // cannot see the app — belongs to the adapter, so the note says both are open
  // and appends the hint that decides. Apple TV is the standing case: this
  // tool's iOS reader has no focus tree to return there at all.
  it("reports a tree that never returned content rather than an observed change", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([axResponse([])])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 200, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(2);
    expect(result.note).toContain("never seen holding anything still");
    expect(result.note).toContain("not an observed change");
    // The adapter's account of WHY the tree was empty has to survive into the
    // note, or the two readings stay indistinguishable to the agent.
    expect(result.note).toContain("not evidence that nothing is on screen");
  });

  // A tree source that dies mid-wait reads as an empty tree, not as a throw:
  // `describeIos` folds the failure into a hint. Counting that as a content
  // change is what let a dead reader come back as the observed change a bare
  // `settled: false` asserts.
  it("does not call a source that went blind mid-wait an observed change", async () => {
    let reads = 0;
    const dying: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 5));
        reads += 1;
        if (reads === 1) return content();
        throw new Error("ax service died");
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(dying));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 300, pollIntervalMs: 30, minStableMs: 100 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(3);
    expect(result.note).toContain("came back empty");
    expect(result.note).toContain("The accessibility read failed (ax service died)");
  });

  // The other order: blank until the app paints, then identical content. The
  // count has to be of the reads that returned content — saying all of them were
  // identical would be a claim about reads that held nothing.
  it("counts only the reads that returned content when the screen painted late", async () => {
    let reads = 0;
    const latePaint: AXServiceApi = {
      degraded: false,
      describe: async () => {
        await new Promise((r) => setTimeout(r, 5));
        reads += 1;
        return reads < 6 ? axResponse([]) : content();
      },
      alertCheck: async () => false,
      ping: async () => true,
    };
    const tool = createAwaitScreenIdleTool(iosRegistry(latePaint));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 400, pollIntervalMs: 30, minStableMs: 5000 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/only \d+ of the \d+ tree reads returned content/);
    expect(result.note).not.toContain("tree reads were all identical");
  });

  // Read repeatedly, never once different, and still `settled: false` — because
  // minStableMs cannot elapse inside this budget. Saying nothing here would
  // assert motion over a screen that was demonstrably still.
  it("reports minStableMs left unconfirmed rather than an observed change", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(5)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 5000 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThan(2);
    expect(result.note).toContain("minStableMs (5000ms)");
    expect(result.note).toContain("stillness left unconfirmed");
  });

  // A cancelled wait observed nothing at all. `await-ui-element` returns its own
  // cancelled note off the same `aborted` flag; without one here the wait
  // reported a tree-too-slow diagnosis for a read it never even issued.
  it("reports a cancelled wait as cancelled, not as a slow read", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(5)));
    const ac = new AbortController();
    ac.abort();

    const result = await tool.execute({}, { udid: IOS_UDID, timeoutMs: 30_000 }, {
      signal: ac.signal,
    } as never);

    expect(result.settled).toBe(false);
    expect(result.polls).toBe(0);
    expect(result.note).toBe("wait was cancelled before the screen settled");
  });

  // Every `settled: false` shape the tool distinguishes has to survive into the
  // line the user reads, or the distinction stops at the JSON.
  it("gives each unsettled shape its own completion message", () => {
    const { interaction } = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));
    const msg = (result: { settled: boolean; note?: string }) =>
      interaction?.completedMsg?.({ params: { udid: IOS_UDID }, result } as never);

    expect(msg({ settled: true })).toBe("Screen settled");
    expect(msg({ settled: false })).toBe("Screen did not settle before timeout");
    expect(msg({ settled: false, note: "last tree fetch failed: device locked" })).toBe(
      "Screen read failed before timeout"
    );
    expect(msg({ settled: false, note: "wait was cancelled before the screen settled" })).toBe(
      "Wait for the screen cancelled"
    );
    expect(msg({ settled: false, note: "all 9 tree reads came back empty" })).toBe(
      "Screen stillness went untested before timeout"
    );
  });

  it("settles on the first non-empty read when minStableMs is 0", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(makeSequencedAXService([content()])));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 2000, pollIntervalMs: 50, minStableMs: 0 }
    );

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(1);
  });
});
