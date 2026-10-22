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

vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));

// The transport is stubbed, so the real dump parser and hint rules run.
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyDisplay: vi.fn(),
  harmonyDumpLayout: vi.fn(),
}));

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_ID = `harmony-${CONNECT_KEY}`;
const DISPLAY = { width: 1216, height: 2688, screenOn: true };

function harmonyRegistry() {
  return {
    resolveService: vi.fn(async (urn: string) => {
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

/** No labels means a dump with no windows. */
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
    // `dumpLayout` serves the last frame while the panel is suspended.
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

  // Unreadable screen must never confirm `hidden`.

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
        timeoutMs: 600,
        pollIntervalMs: 50,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/last tree fetch failed/i);
    expect(result.note).toMatch(noteFragment);
  });

  it("does NOT report `hidden` success when the dump lists no windows", async () => {
    sequenceDumps([dumpWith()]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 600,
        pollIntervalMs: 50,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/empty or unreadable/i);
    expect(result.note).toMatch(/no windows/i);
  });

  it("times out `unreadable`, not `unmet`, when every read came off a suspended panel", async () => {
    vi.mocked(harmonyDisplay).mockResolvedValue({ ...DISPLAY, screenOn: false });
    sequenceDumps([dumpWith("Loading")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 300,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.cause).toBe("unreadable");
    expect(result.note).toMatch(/display is off/i);
  });

  it("times out `unreadable` when the panel went off after the last live read", async () => {
    vi.mocked(harmonyDisplay)
      .mockResolvedValueOnce(DISPLAY)
      .mockResolvedValue({ ...DISPLAY, screenOn: false });
    sequenceDumps([dumpWith("Loading")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 600,
        pollIntervalMs: 100,
      }
    );

    expect(result.success).toBe(false);
    expect(result.cause).toBe("unreadable");
  });

  it("times out `unreadable` when a suspended-panel read lands at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      vi.mocked(harmonyDisplay)
        .mockResolvedValueOnce(DISPLAY)
        .mockResolvedValue({ ...DISPLAY, screenOn: false });
      vi.mocked(harmonyDumpLayout)
        .mockResolvedValueOnce(dumpWith("Loading"))
        .mockImplementation(async () => {
          vi.setSystemTime(start + 1500);
          return dumpWith("Loading");
        });
      const tool = createAwaitUiElementTool(harmonyRegistry());

      const result = await tool.execute(
        {},
        {
          udid: HARMONY_ID,
          condition: "visible",
          selector: { text: "Submit" },
          timeoutMs: 1500,
          pollIntervalMs: 100,
        }
      );

      expect(vi.mocked(harmonyDumpLayout)).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(false);
      expect(result.cause).toBe("unreadable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out `unmet` when the panel was on for the final read", async () => {
    vi.mocked(harmonyDisplay)
      .mockResolvedValueOnce({ ...DISPLAY, screenOn: false })
      .mockResolvedValue(DISPLAY);
    sequenceDumps([dumpWith("Loading")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 600,
        pollIntervalMs: 100,
      }
    );

    expect(result.success).toBe(false);
    expect(result.cause).toBe("unmet");
  });

  it("times out a `hidden` wait `unmet` when the deadline poll gets no budget", async () => {
    // Reads at 0/400/800ms, then the loop sleeps 200ms and polls again at the
    // deadline with nothing left; every read saw the element.
    sequenceDumps([dumpWith("Spinner")]);
    const tool = createAwaitUiElementTool(harmonyRegistry());

    const result = await tool.execute(
      {},
      {
        udid: HARMONY_ID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 1000,
        pollIntervalMs: 400,
      }
    );

    expect(result.success).toBe(false);
    expect(result.cause).toBe("unmet");
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

  it("gives the read only what is left of the wait, so an abandoned dump frees the queue", async () => {
    // An abandoned `uitest` read holds the device queue until killed.
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
