import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  harmonyDisplay,
  harmonyDumpLayout,
  HARMONY_DISPLAY_TIMEOUT_MS,
  UITEST_TIMEOUT_MS,
  type HarmonyLayoutNode,
} from "../src/utils/harmony-uitest";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// Stub the `uitest`-over-`hdc` transport rather than `describeHarmony` itself,
// so the wait tools poll through the real dump parser and the real hint rules —
// those are what decide whether an unreadable screen may confirm `hidden`.
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyDisplay: vi.fn(),
  harmonyDumpLayout: vi.fn(),
}));

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_ID = `harmony-${CONNECT_KEY}`;
const DISPLAY = { width: 1216, height: 2688, screenOn: true };

// Neither wait tool resolves a service on harmony — the tree comes straight off
// `hdc` — so any lookup here is a wiring mistake, not a missing fixture.
function harmonyRegistry() {
  return {
    resolveService: vi.fn(async (urn: string) => {
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

/**
 * A `uitest dumpLayout` result shaped like a Mate 60's: one bounded root, one
 * app window, and a `Text` node per label. No labels means a dump with no
 * windows at all — the "layout came back blank" case.
 */
function dumpWith(...labels: string[]): HarmonyLayoutNode {
  return {
    attributes: { bounds: "[0,0][1216,2688]" },
    children: [
      {
        attributes: {
          type: "WindowScene",
          bundleName: "com.demo.app",
          bounds: "[0,0][1216,2688]",
        },
        children: labels.map((text, i) => ({
          attributes: {
            type: "Text",
            text,
            bounds: `[100,${200 + i * 200}][900,${340 + i * 200}]`,
          },
        })),
      },
    ],
  };
}

/** Serve `dumps` one per poll, repeating the last — a screen that changes mid-wait. */
function sequenceDumps(dumps: HarmonyLayoutNode[]): { calls: () => number } {
  let i = 0;
  vi.mocked(harmonyDumpLayout).mockImplementation(
    async () => dumps[Math.min(i++, dumps.length - 1)]
  );
  return { calls: () => i };
}

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["hdc"]);
  vi.mocked(harmonyDisplay).mockReset().mockResolvedValue(DISPLAY);
  vi.mocked(harmonyDumpLayout).mockReset();
});

describe("await-ui-element on HarmonyOS", () => {
  it("`visible` succeeds once the element appears in the dump", async () => {
    const { calls } = sequenceDumps([dumpWith("Loading"), dumpWith("Submit")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(calls()).toBeGreaterThan(1);
  });

  it("`visible` succeeds against a suspended panel but says the display is off", async () => {
    // `uitest dumpLayout` keeps serving the last composited frame while the
    // panel is suspended, so the element is "there" and the wait is right to
    // resolve — but the following tap lands nowhere. Without the caveat a
    // wait-then-tap loop runs to completion against a dead screen.
    vi.mocked(harmonyDisplay).mockResolvedValue({ ...DISPLAY, screenOn: false });
    sequenceDumps([dumpWith("Submit")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note).toMatch(/display is off/i);
    expect(result.note).toMatch(/taps land nowhere/i);
  });

  it("passes the bare connect key to `uitest`, not the `harmony-` prefixed device id", async () => {
    sequenceDumps([dumpWith("Submit")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "exists",
        selector: { text: "Submit" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(harmonyDisplay).toHaveBeenCalledWith(CONNECT_KEY, expect.any(Number));
    expect(harmonyDumpLayout).toHaveBeenCalledWith(
      CONNECT_KEY,
      expect.any(String),
      expect.any(Number)
    );
  });

  it("`hidden` succeeds once the element leaves a still-populated screen", async () => {
    // The rest of the screen survives, which is what a genuine disappearance
    // looks like; a dump with nothing left in it is the ambiguous case below.
    sequenceDumps([dumpWith("Spinner"), dumpWith("Content")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note ?? "").not.toMatch(/never matched/i);
  });

  it("`hidden` met on sight against a suspended panel still says the display is off", async () => {
    // The two notes are not alternatives: a screen that went dark holds a frame
    // the selector never matched, so this wait meets its condition at once AND
    // is the one most likely to be followed by a tap into a dead panel.
    vi.mocked(harmonyDisplay).mockResolvedValue({ ...DISPLAY, screenOn: false });
    sequenceDumps([dumpWith("Content")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note).toMatch(/never matched/i);
    expect(result.note).toMatch(/display is off/i);
  });

  // ── Unreadable screen must never confirm `hidden` ─────────────────────────
  // Same guarantee as the iOS "AX backend is down" and Android "empty dump"
  // cases, reached differently: harmony's fetcher throws instead of returning a
  // flagged empty tree, so what protects it is `pollDescribeTree` never handing
  // a failed fetch to the sample predicate.

  it.each([
    {
      when: "hdc cannot reach the device",
      fail: () =>
        vi
          .mocked(harmonyDisplay)
          .mockRejectedValue(new Error("[Fail]Not match target founded, check connect-key please")),
      noteFragment: /Not match target founded/,
    },
    {
      when: "uitest cannot dump the layout",
      fail: () =>
        vi
          .mocked(harmonyDumpLayout)
          .mockRejectedValue(
            new Error(`uitest dumpLayout failed on ${CONNECT_KEY}: Invalid parameters.`)
          ),
      noteFragment: /Invalid parameters/,
    },
  ])("does NOT report `hidden` success when $when", async ({ fail, noteFragment }) => {
    fail();
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/last tree fetch failed/i);
    expect(result.note).toMatch(noteFragment);
  });

  it("does NOT report `hidden` success when the dump lists no windows", async () => {
    // A dump that fetched cleanly but holds nothing is still not evidence the
    // element is gone. Unlike Android — where only a prior match makes an empty
    // tree suspicious — describeHarmony flags every windowless dump, so the
    // blind-read guard fires from the very first poll and the hint reaches the note.
    sequenceDumps([dumpWith()]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/empty or unreadable/i);
    expect(result.note).toMatch(/no windows/i);
  });
});

describe("await-screen-idle on HarmonyOS", () => {
  it("settles once the dump stops changing", async () => {
    sequenceDumps([dumpWith(), dumpWith("Settings")]);
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
    expect(result.polls).toBeGreaterThan(1);
  });

  it("settles instantly on a suspended panel but says the display is off", async () => {
    // A frozen frame is maximally still, so this is the one screen that settles
    // fastest and means it least. `await-ui-element` carries the same caveat off
    // the same read — the two must not disagree about a screen they both just
    // described, since the agent's next call after either is a tap.
    vi.mocked(harmonyDisplay).mockResolvedValue({ ...DISPLAY, screenOn: false });
    sequenceDumps([dumpWith("Settings")]);
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 30 }
    );

    expect(result.settled).toBe(true);
    expect(result.note).toMatch(/display is off/i);
    expect(result.note).toMatch(/taps land nowhere/i);
  });

  it("says why the screen was never readable, not just that it never settled", async () => {
    // A windowless dump can never settle — the loop wants content before it
    // starts timing stability — so this ends as a timeout with the reason
    // already in hand. Dropped, "did not settle" reads as a busy screen and the
    // caller waits longer for a screen that is not being drawn; the sibling
    // `await-ui-element` puts the same hint on its own timeout note, off the
    // very same read.
    sequenceDumps([dumpWith()]);
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 40, pollIntervalMs: 10, minStableMs: 10 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/no windows/i);
  });

  it("gives the read only what is left of the wait, so an abandoned dump frees the queue", async () => {
    // The wait abandons a read it cannot finish but cannot cancel one, and a
    // `uitest` client holds this device's queue until it is killed. Left on its
    // own 20s ceiling, a read abandoned at a 300ms deadline is time the caller's
    // NEXT call spends queued — measured at 0.8s of it on a warm emulator, on
    // the auto-screenshot that follows every interaction.
    const budgets: (number | undefined)[] = [];
    vi.mocked(harmonyDumpLayout).mockImplementation(async (_key, _path, timeoutMs) => {
      budgets.push(timeoutMs);
      return dumpWith("Content");
    });
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 500, pollIntervalMs: 10, minStableMs: 10 }
    );

    expect(budgets.length).toBeGreaterThan(0);
    for (const budget of budgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(500);
    }
    expect(harmonyDisplay).toHaveBeenCalledWith(CONNECT_KEY, expect.any(Number));
  });

  it("caps each leg at its own ceiling, so a long wait buys retries not one long round trip", async () => {
    // The other direction of the same rule: a wait may hand a read far MORE than
    // one `hdc` round trip is allowed to take (120s is the schema max). Passing
    // that through would spend the whole wait inside a single wedged call, and
    // the loop would poll exactly once.
    const dumpBudgets: (number | undefined)[] = [];
    vi.mocked(harmonyDumpLayout).mockImplementation(async (_key, _path, timeoutMs) => {
      dumpBudgets.push(timeoutMs);
      return dumpWith("Content");
    });
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 120_000, pollIntervalMs: 5, minStableMs: 10 }
    );

    expect(dumpBudgets.length).toBeGreaterThan(0);
    for (const budget of dumpBudgets) expect(budget).toBeLessThanOrEqual(UITEST_TIMEOUT_MS);
    for (const [, budget] of vi.mocked(harmonyDisplay).mock.calls) {
      expect(budget).toBeLessThanOrEqual(HARMONY_DISPLAY_TIMEOUT_MS);
    }
  });

  it("does not settle while the dump keeps changing (times out)", async () => {
    sequenceDumps(Array.from({ length: 30 }, (_, i) => dumpWith(`item-${i}`)));
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 80, pollIntervalMs: 5, minStableMs: 40 }
    );

    expect(result.settled).toBe(false);
  });

  it("passes the bare connect key to `uitest`, not the `harmony-` prefixed device id", async () => {
    sequenceDumps([dumpWith("Settings")]);
    const tool = createAwaitScreenIdleTool(harmonyRegistry());

    await tool.execute(
      {},
      { udid: HARMONY_ID, timeoutMs: 2000, pollIntervalMs: 10, minStableMs: 0 }
    );

    expect(harmonyDisplay).toHaveBeenCalledWith(CONNECT_KEY, expect.any(Number));
    expect(harmonyDumpLayout).toHaveBeenCalledWith(
      CONNECT_KEY,
      expect.any(String),
      expect.any(Number)
    );
  });
});
