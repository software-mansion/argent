import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createWaitTool, findAll, evaluateMatches } from "../src/tools/wait";
import type { DescribeNode } from "../src/tools/describe/contract";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

// An AX service whose describe() walks through `responses` one call at a time,
// repeating the last entry. Lets a test simulate a screen that changes between
// polls (element appears / disappears / text updates).
function makeSequencedAXService(responses: AXDescribeResponse[]): {
  api: AXServiceApi;
  calls: () => number;
} {
  let i = 0;
  const api: AXServiceApi = {
    degraded: false,
    describe: async () => responses[Math.min(i++, responses.length - 1)],
    alertCheck: async () => false,
    ping: async () => true,
  };
  return { api, calls: () => i };
}

function axResponse(elements: AXDescribeResponse["elements"]): AXDescribeResponse {
  return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements };
}

const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

function makeMockRegistry(axService: AXServiceApi) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return axService;
      // wait never needs native-devtools when AX returns elements; an empty
      // AX tree would fall through to here, so fail loudly to surface misuse.
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

describe("wait tool", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("condition `time` sleeps and reports success without touching a device", async () => {
    const registry = makeMockRegistry({} as AXServiceApi);
    const tool = createWaitTool(registry);

    const result = await tool.execute({}, { condition: "time", durationMs: 20 });

    expect(result.success).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(20);
    expect(registry.resolveService).not.toHaveBeenCalled();
  });

  it("`visible` succeeds once the element appears across polls", async () => {
    const { api, calls } = makeSequencedAXService([
      axResponse([]),
      axResponse([{ label: "Submit", frame: FRAME, traits: ["button"] }]),
    ]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(calls()).toBeGreaterThan(1);
  });

  it("`visible` times out with a diagnostic note when the element never appears", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 30,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(30);
    expect(result.note).toMatch(/no element matched/i);
  });

  it("clamps the poll sleep to the deadline so a large pollIntervalMs can't overshoot timeoutMs", async () => {
    // Element never appears; pollIntervalMs (1000) dwarfs timeoutMs (100). Without
    // clamping, the first sleep alone would run the full 1000ms past the initial
    // poll. With the clamp, elapsed should land just past the 100ms deadline.
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 100,
        pollIntervalMs: 1000,
      }
    );

    expect(result.success).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(100);
    expect(result.elapsed).toBeLessThan(600);
  });

  it("`exists` succeeds when the element is in the tree", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Widget", frame: FRAME, traits: [] }]),
    ]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "exists",
        selector: { text: "Widget" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`hidden` returns an instant success but flags a selector that never matched", async () => {
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Ghost" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
    expect(result.note).toMatch(/never matched/i);
  });

  it("aborts promptly when the request signal fires mid-wait", async () => {
    // Tree never matches, so without cancellation this would run the full 5s.
    const { api } = makeSequencedAXService([axResponse([])]);
    const tool = createWaitTool(makeMockRegistry(api));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Nope" },
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      { signal: controller.signal } as never
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    expect(result.elapsed).toBeLessThan(2000);
  });

  it("`time` returns a cancelled result when the signal fires during the sleep", async () => {
    const tool = createWaitTool(makeMockRegistry({} as AXServiceApi));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await tool.execute({}, { condition: "time", durationMs: 5000 }, {
      signal: controller.signal,
    } as never);

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/cancel/i);
    expect(result.elapsed).toBeLessThan(2000);
  });

  it("`hidden` succeeds once the element disappears", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Spinner", frame: FRAME, traits: [] }]),
      axResponse([]),
    ]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "hidden",
        selector: { text: "Spinner" },
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`text` succeeds once the matched element contains the expected substring", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Status", value: "Loading", frame: FRAME, traits: [] }]),
      axResponse([{ label: "Status", value: "Done", frame: FRAME, traits: [] }]),
    ]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "text",
        selector: { text: "Status" },
        expectedText: "done",
        timeoutMs: 2000,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(true);
  });

  it("`text` timeout note reports the last-seen text", async () => {
    const { api } = makeSequencedAXService([
      axResponse([{ label: "Status", value: "Loading", frame: FRAME, traits: [] }]),
    ]);
    const tool = createWaitTool(makeMockRegistry(api));

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "text",
        selector: { text: "Status" },
        expectedText: "Done",
        timeoutMs: 30,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/Loading/);
  });

  // The selector is a substring match, so it can hit more than one node. These
  // pin the "evaluate across all matches" behaviour: a zero-area match that
  // sorts before a visible one must not flip `visible`/`hidden` the wrong way.
  describe("multi-match condition evaluation", () => {
    const VISIBLE = { x: 0.1, y: 0.4, width: 0.5, height: 0.05 };
    const ZERO = { x: 0.1, y: 0.4, width: 0, height: 0 };
    const node = (
      label: string,
      frame: { x: number; y: number; width: number; height: number },
      children: DescribeNode[] = []
    ): DescribeNode => ({ role: "AXStaticText", frame, children, label });
    const tree = (children: DescribeNode[]): DescribeNode => ({
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children,
    });
    type EvalParams = Parameters<typeof evaluateMatches>[0];
    const params = (condition: string, expectedText?: string): EvalParams =>
      ({ condition, selector: { text: "Item" }, expectedText }) as unknown as EvalParams;

    it("findAll collects every match, including nested ones", () => {
      const t = tree([node("Row", VISIBLE, [node("Item", VISIBLE)]), node("Item", ZERO)]);
      expect(findAll(t, { text: "Item" })).toHaveLength(2);
    });

    it("`visible` succeeds when a later match is visible even if an earlier match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", VISIBLE)]), { text: "Item" });
      expect(matches).toHaveLength(2);
      expect(evaluateMatches(params("visible"), matches)).toBe(true);
    });

    it("`hidden` stays unsatisfied while any match is still visible (earlier match zero-area)", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", VISIBLE)]), { text: "Item" });
      expect(evaluateMatches(params("hidden"), matches)).toBe(false);
    });

    it("`visible` fails when every match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO), node("Item", ZERO)]), { text: "Item" });
      expect(evaluateMatches(params("visible"), matches)).toBe(false);
    });

    it("`hidden` succeeds when every match is zero-area", () => {
      const matches = findAll(tree([node("Item", ZERO)]), { text: "Item" });
      expect(evaluateMatches(params("hidden"), matches)).toBe(true);
    });

    it("`text` inspects the first match in tree order, not any match", () => {
      const matches = findAll(tree([node("Item one", VISIBLE), node("Item two", VISIBLE)]), {
        text: "Item",
      });
      expect(evaluateMatches(params("text", "two"), matches)).toBe(false);
      expect(evaluateMatches(params("text", "one"), matches)).toBe(true);
    });
  });

  describe("schema validation", () => {
    const schema = createWaitTool(makeMockRegistry({} as AXServiceApi)).zodSchema!;

    it("rejects `time` without durationMs", () => {
      expect(schema.safeParse({ condition: "time" }).success).toBe(false);
    });

    it("rejects `time` with durationMs over the 120000ms cap", () => {
      expect(schema.safeParse({ condition: "time", durationMs: 200_000 }).success).toBe(false);
    });

    it("rejects a selector condition without udid", () => {
      expect(schema.safeParse({ condition: "visible", selector: { text: "x" } }).success).toBe(
        false
      );
    });

    it("rejects a selector condition without a selector", () => {
      expect(schema.safeParse({ condition: "visible", udid: IOS_UDID }).success).toBe(false);
    });

    it("rejects `text` without expectedText", () => {
      expect(
        schema.safeParse({ condition: "text", udid: IOS_UDID, selector: { text: "x" } }).success
      ).toBe(false);
    });

    it("rejects a selector with no fields", () => {
      expect(schema.safeParse({ condition: "exists", udid: IOS_UDID, selector: {} }).success).toBe(
        false
      );
    });

    it("accepts a valid visible-condition payload", () => {
      expect(
        schema.safeParse({ condition: "visible", udid: IOS_UDID, selector: { role: "button" } })
          .success
      ).toBe(true);
    });
  });
});
