import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
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

const CHROMIUM_ID = "chromium-cdp-9222";

// The Chromium equivalent of `content()`: one labelled node under the document.
const DOM_TREE = {
  role: "html",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [
    {
      role: "button",
      label: "Continue",
      clickable: true,
      frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.05 },
      children: [],
    },
  ],
};

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
    expect(result.note).toContain("the screen was never read");
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
    expect(result.note).toContain("only 1 tree read");
    expect(result.note).toContain("pollIntervalMs (2000ms)");
    expect(result.note).toContain("never sampled twice");
    expect(result.note).not.toContain("outran the budget");
  });

  // The MCP auto-screenshot readiness wait passes timeoutMs 100 after `describe`
  // with the default interval, so the default path hits the same starve.
  it("names pollIntervalMs on the default interval when timeoutMs is small", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(5)));

    const result = await tool.execute({}, { udid: IOS_UDID, timeoutMs: 100 });

    expect(result.note).toContain("only 1 tree read");
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
    expect(result.note).toContain("a second read plus the shortest poll interval");
    expect(result.note).toContain("Raise timeoutMs");
    // The interval is not the knob here, so it must not be named as one — but
    // the note may not rule it out either: a faster next read could still fit.
    expect(result.note).not.toContain("pollIntervalMs (400ms)");
    expect(result.note).toContain("only if the next read is faster");
  });

  // A tree read many times over with nothing in it is not a screen that kept
  // changing. Which of the two reasons it is — nothing rendered, or the reader
  // cannot see the app — belongs to the adapter, so the note says both are open
  // and appends the hint that decides. Apple TV is the standing case: this
  // tool's iOS reader has no focus tree to return there at all.
  // A read that used half the budget, and a poll sleep that then handed the next
  // one less than it needs, so the deadline abandoned it. That fetch timed out on
  // the schedule, not on the tree, so this must not read as the tree outrunning
  // the budget — and because the final attempt did not settle, its cut-off
  // duration is no evidence a read that size cannot fit, so the note names no
  // knob with confidence (the sibling await-ui-element draws the same line).
  it("does not call a read that took half the budget one that outran it", async () => {
    const tool = createAwaitScreenIdleTool(iosRegistry(fastAx(200)));

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 400, pollIntervalMs: 100, minStableMs: 250 }
    );

    expect(result.polls).toBe(2);
    expect(result.note).not.toContain("outran the budget");
    expect(result.note).toContain("only one tree read completed");
    expect(result.note).toContain("Raise timeoutMs");
  });

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
  it("keeps a fetch failure the deadline hid from the last-attempt check", async () => {
    // Chromium, because a throw out of the iOS AX service is swallowed into an
    // empty tree plus a hint — it never reaches `lastError`. Here the failing
    // read is not the LAST attempt either: the one after it is still in flight
    // when the deadline lands, so the fetch-failed arm cannot see it. Without
    // the append the note offers `minStableMs` and `timeoutMs` to a caller whose
    // renderer has gone.
    let call = 0;
    const chromium = {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async (method: string) => {
          if (method !== "Runtime.evaluate") return {};
          call += 1;
          if (call <= 2) return { result: { value: JSON.stringify({ tree: DOM_TREE }) } };
          if (call === 3) throw new Error("renderer detached");
          return new Promise(() => {});
        },
      },
    } as unknown as ChromiumCdpApi;
    const tool = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));

    const result = await tool.execute(
      { chromium },
      { udid: CHROMIUM_ID, timeoutMs: 500, pollIntervalMs: 50, minStableMs: 5000 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/minStableMs/);
    expect(result.note).toMatch(/a tree read also failed: renderer detached/);
  });

  it("does not call a lone content read identical to anything", async () => {
    // One read with content and the rest empty. Nothing was compared, so the
    // note must not describe a comparison — the arm below it would say the
    // reads "were identical".
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([content(), axResponse([])]))
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 300, pollIntervalMs: 60, minStableMs: 100 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/never compared with anything/);
    expect(result.note).not.toMatch(/identical/);
  });

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

  // The counter has to be TRAILING blanks, not any blank: a blank in the middle
  // of a run that ends with content leaves the deadline properly watched, and
  // the arm below must not fire on it and report a last read that came back
  // empty when the last read had content.
  it("keeps a blank in the middle from reading as a dark tail", async () => {
    const tool = createAwaitScreenIdleTool(
      iosRegistry(
        makeSequencedAXService([
          content(),
          axResponse([]),
          axResponse([{ label: "Moved", frame: FRAME, traits: ["button"] }]),
        ])
      )
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 400, pollIntervalMs: 50, minStableMs: 5000 }
    );

    expect(result.settled).toBe(false);
    // The screen was seen changing and was still being watched at the deadline:
    // the bare verdict is the whole answer.
    expect(result.note).toBeUndefined();
  });

  // A change seen early, then a reader that goes dark and stays dark. The change
  // is real — two content reads did differ — but nothing watched the screen up
  // to the deadline, and a bare `settled: false` claims the motion was followed
  // to the end. On iOS a run of empty trees is what a failing read looks like.
  it("does not report motion it stopped watching as motion up to the deadline", async () => {
    const tool = createAwaitScreenIdleTool(
      iosRegistry(
        makeSequencedAXService([
          content(),
          axResponse([{ label: "Moved", frame: FRAME, traits: ["button"] }]),
          axResponse([]),
        ])
      )
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 400, pollIntervalMs: 50, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/seen changing/);
    expect(result.note).toMatch(/came back empty/);
    expect(result.note).toMatch(/stillness is untested/);
  });

  // The cancel arm and the fetch-failed arm can both be true at once: a fetch
  // that threw sets `lastError`, and the caller giving up during the next poll
  // sleep sets `aborted`. Cancellation is the truer answer — the wait stopped
  // because the caller stopped it — so it has to be tested first. The already-
  // aborted test above leaves `lastError` unset and cannot see the order.
  it("prefers cancelled over a fetch error that happened before the cancel", async () => {
    const tool = createAwaitScreenIdleTool({
      resolveService: vi.fn(async () => {
        throw new Error("no android-devtools helper");
      }),
    } as any);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);

    const result = await tool.execute({}, { udid: "emulator-5554", timeoutMs: 30_000 }, {
      signal: ac.signal,
    } as never);

    expect(result.polls).toBeGreaterThan(0);
    expect(result.note).toBe("wait was cancelled before the screen settled");
  });

  // The upper edge of the two-sample gate. A wait that DID compare the screen
  // with itself must not be told it never was — widening the threshold to 3 is
  // otherwise invisible.
  it("does not claim a two-sample wait was never sampled twice", async () => {
    // Two content reads, then empties: enough samples to compare, and a verdict
    // that still cannot be `settled`.
    const tool = createAwaitScreenIdleTool(
      iosRegistry(makeSequencedAXService([content(), content(), axResponse([])]))
    );

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 400, pollIntervalMs: 50, minStableMs: 5000 }
    );

    expect(result.settled).toBe(false);
    expect(result.polls).toBeGreaterThanOrEqual(3);
    expect(result.note).not.toMatch(/never sampled twice/);
    expect(result.note).toMatch(/minStableMs/);
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

  // A DOM tree carrying one labelled node, so successive labels read as content
  // that changed.
  const domTree = (label: string) => ({
    role: "html",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      { role: "button", label, frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.05 }, children: [] },
    ],
  });

  // One read landed and the deadline then abandoned a second one. The abandoned
  // fetch's cut-off duration is no evidence a read that size cannot fit, so the
  // note must not quote it as "one tree fetch took Xms" nor blame pollIntervalMs
  // with confidence — the sibling await-ui-element draws the same line.
  it("does not blame a knob when one read landed and the next was abandoned", async () => {
    let call = 0;
    const chromium = {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async (method: string) => {
          if (method !== "Runtime.evaluate") return {};
          call += 1;
          if (call === 1) {
            await new Promise((r) => setTimeout(r, 5));
            return { result: { value: JSON.stringify({ tree: domTree("A") }) } };
          }
          return new Promise(() => {});
        },
      },
    } as unknown as ChromiumCdpApi;
    const tool = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));

    const result = await tool.execute(
      { chromium },
      { udid: CHROMIUM_ID, timeoutMs: 80, pollIntervalMs: 10, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toContain("only one tree read completed");
    expect(result.note).not.toContain("one tree fetch took");
    expect(result.note).not.toContain("pollIntervalMs (10ms)");
  });

  // The screen was seen CHANGING, then a read failed and the last fetch was
  // abandoned. A bare `settled: false` would assert the motion was watched to the
  // deadline; it was not, and the failure must not be dropped.
  it("does not call a change watched to the end when the reads then failed", async () => {
    let call = 0;
    const chromium = {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async (method: string) => {
          if (method !== "Runtime.evaluate") return {};
          call += 1;
          if (call === 1) return { result: { value: JSON.stringify({ tree: domTree("A") }) } };
          if (call === 2) return { result: { value: JSON.stringify({ tree: domTree("B") }) } };
          if (call === 3) throw new Error("renderer detached");
          return new Promise(() => {});
        },
      },
    } as unknown as ChromiumCdpApi;
    const tool = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));

    const result = await tool.execute(
      { chromium },
      { udid: CHROMIUM_ID, timeoutMs: 200, pollIntervalMs: 10, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("seen changing");
    expect(result.note).toContain("stillness is untested");
    expect(result.note).toContain("a tree read also failed: renderer detached");
  });

  // One read came back and earlier fetches failed: the window was mostly blind,
  // so the single sample is the failures' doing, not the schedule's.
  it("names earlier failures behind a single-sample verdict", async () => {
    let call = 0;
    const chromium = {
      refreshViewport: async () => ({ width: 1024, height: 768 }),
      cdp: {
        send: async (method: string) => {
          if (method !== "Runtime.evaluate") return {};
          call += 1;
          if (call <= 3) throw new Error("renderer detached");
          return { result: { value: JSON.stringify({ tree: domTree("A") }) } };
        },
      },
    } as unknown as ChromiumCdpApi;
    const tool = createAwaitScreenIdleTool(iosRegistry({} as AXServiceApi));

    const result = await tool.execute(
      { chromium },
      { udid: CHROMIUM_ID, timeoutMs: 100, pollIntervalMs: 25, minStableMs: 250 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toContain("earlier");
    expect(result.note).toMatch(/reads? failed/);
    expect(result.note).not.toContain("pollIntervalMs (25ms) that leaves no room");
  });
});
