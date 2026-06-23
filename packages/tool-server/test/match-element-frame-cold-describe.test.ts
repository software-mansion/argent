import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeNode } from "../src/tools/describe/contract";

vi.mock("../src/utils/device-info", () => ({
  resolveDevice: vi.fn(() => ({
    platform: "ios",
    udid: "TEST-UDID",
    name: "iPhone",
    state: "Booted",
  })),
}));
vi.mock("../src/tools/describe/platforms/ios", () => ({ describeIos: vi.fn() }));
vi.mock("../src/tools/describe/platforms/android", () => ({ describeAndroid: vi.fn() }));

import { captureElementFrame, findElementMatch } from "../src/utils/match-element-frame";
import { describeIos } from "../src/tools/describe/platforms/ios";

const describeIosMock = vi.mocked(describeIos);
const registry = {} as Registry;

const headerFrame = { x: 0.068, y: 0.092, width: 0.294, height: 0.033 };
const tabFrame = { x: 0, y: 0.923, width: 0.25, height: 0.077 };
const rowFrame = { x: 0, y: 0.215, width: 1, height: 0.13 };
const ROOT_FRAME = { x: 0, y: 0, width: 1, height: 1 };
const match = { by: "text" as const, value: "Favourites" };
// Zero retry delay so the warm-up loop runs instantly in tests.
const FAST = { attempts: 8, retryMs: 0 };

function node(
  role: string,
  label: string | undefined,
  frame: { x: number; y: number; width: number; height: number },
  children: DescribeNode[] = []
): DescribeNode {
  return { role, label, frame, children };
}

// The empty/cold tree iOS returns for the first ~1s+ after a screen appears.
const COLD = { source: "ax-service" as const, tree: node("AXGroup", undefined, ROOT_FRAME, []) };

// A half-built tree: the persistent bottom tab ("Favourites (5)") has landed but
// the screen's own header has NOT yet rendered. Its label is a SUBSTRING of
// "Favourites" — the distractor that must not win.
const HALF_BUILT_TAB = {
  source: "ax-service" as const,
  tree: node("AXGroup", undefined, ROOT_FRAME, [
    node("AXButton", ", , Favourites (5)", tabFrame),
    node("AXButton", ", , Browse", { x: 0.25, y: 0.923, width: 0.25, height: 0.077 }),
    node("AXButton", ", , Map", { x: 0.5, y: 0.923, width: 0.25, height: 0.077 }),
  ]),
};

// A fully-rendered Favourites screen: BOTH the header (exact "Favourites") and
// the tab ("Favourites (5)", substring) match — the exact header must win.
const WARM = {
  source: "ax-service" as const,
  tree: node("AXGroup", undefined, ROOT_FRAME, [
    node("AXStaticText", "Favourites", headerFrame),
    node("AXStaticText", "5 saved · 0 total stats", {
      x: 0.068,
      y: 0.127,
      width: 0.294,
      height: 0.015,
    }),
    node("AXButton", ", , Favourites (5)", tabFrame),
    node("AXButton", ", , Browse", { x: 0.25, y: 0.923, width: 0.25, height: 0.077 }),
  ]),
};

// A fully-rendered DIFFERENT screen — no "Favourites" anywhere.
const WARM_OTHER = {
  source: "ax-service" as const,
  tree: node("AXGroup", undefined, ROOT_FRAME, [
    node("AXStaticText", "Browse", { x: 0.068, y: 0.092, width: 0.2, height: 0.033 }),
    node("AXButton", ", , Browse", { x: 0.25, y: 0.923, width: 0.25, height: 0.077 }),
    node("AXButton", ", , Map", { x: 0.5, y: 0.923, width: 0.25, height: 0.077 }),
    node("AXButton", ", , Compare", { x: 0.75, y: 0.923, width: 0.25, height: 0.077 }),
  ]),
};

// A list row whose label only CONTAINS the query — no exact hit possible.
const ROW = {
  source: "ax-service" as const,
  tree: node("AXGroup", undefined, ROOT_FRAME, [
    node("AXGroup", "simisear, gluttony, blaze, ", rowFrame),
  ]),
};

describe("captureElementFrame — holds out for the exact element through warm-up", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips the half-built same-text tab and resolves the exact header once it renders", async () => {
    describeIosMock
      .mockResolvedValueOnce(COLD)
      .mockResolvedValueOnce(HALF_BUILT_TAB)
      .mockResolvedValueOnce(WARM);
    const frame = await captureElementFrame(registry, "TEST-UDID", match, FAST);
    expect(frame).toEqual(headerFrame); // header, NOT the bottom tab
    expect(frame).not.toEqual(tabFrame);
    expect(describeIosMock.mock.calls.length).toBe(3);
  });

  it("returns the exact header immediately when the screen is already warm", async () => {
    describeIosMock.mockResolvedValue(WARM);
    const frame = await captureElementFrame(registry, "TEST-UDID", match, FAST);
    expect(frame).toEqual(headerFrame);
    expect(describeIosMock.mock.calls.length).toBe(1);
  });

  it("falls back to a substring match after the budget when no exact hit exists", async () => {
    describeIosMock.mockResolvedValue(ROW);
    const frame = await captureElementFrame(
      registry,
      "TEST-UDID",
      { by: "text", value: "simisear" },
      { attempts: 3, retryMs: 0 }
    );
    expect(frame).toEqual(rowFrame);
    expect(describeIosMock.mock.calls.length).toBe(3);
  });

  it("returns null when the element is absent within the budget", async () => {
    describeIosMock.mockResolvedValue(WARM_OTHER);
    const frame = await captureElementFrame(registry, "TEST-UDID", match, {
      attempts: 3,
      retryMs: 0,
    });
    expect(frame).toBeNull();
    expect(describeIosMock.mock.calls.length).toBe(3);
  });

  it("keeps a substring partial when a LATER attempt re-empties (tree regressed mid-warm-up)", async () => {
    // A substring hit lands first, then the AX tree re-empties (a transient the
    // device can return while still settling). The held partial must survive —
    // an "if the latest attempt is empty, return null" refactor would drop it.
    describeIosMock
      .mockResolvedValueOnce(ROW)
      .mockResolvedValueOnce(COLD)
      .mockResolvedValueOnce(COLD);
    const frame = await captureElementFrame(
      registry,
      "TEST-UDID",
      { by: "text", value: "simisear" },
      { attempts: 3, retryMs: 0 }
    );
    expect(frame).toEqual(rowFrame); // the attempt-1 partial, not null
    expect(describeIosMock.mock.calls.length).toBe(3); // no exact hit → full budget
  });

  it("stops well before the full attempt count once the wall-clock budget is spent (slow describe)", async () => {
    // Each describe is slow, like an Android `uiautomator` dump. An instant
    // describe would run all 8 attempts (see the absent-element test above); the
    // time budget must cut the loop short so propose_variant can't block for
    // 8 × a multi-second describe (the measured 18–23s Android stall).
    describeIosMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return WARM_OTHER; // no "Favourites" → never an exact hit
    });
    const frame = await captureElementFrame(registry, "TEST-UDID", match, {
      attempts: 8,
      retryMs: 0,
      budgetMs: 100,
    });
    expect(frame).toBeNull(); // absent → still best-effort null
    // ~40ms/describe under a 100ms budget → a couple of calls, and crucially far
    // fewer than the 8 attempts an instant describe would have run.
    expect(describeIosMock.mock.calls.length).toBeLessThan(8);
    expect(describeIosMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("findElementMatch — exact beats substring", () => {
  it("prefers the exact 'Favourites' header over the 'Favourites (5)' tab", () => {
    expect(findElementMatch(WARM.tree, match)).toEqual({ frame: headerFrame, exact: true });
  });

  it("reports a substring-only hit as inexact", () => {
    const hit = findElementMatch(ROW.tree, { by: "text", value: "simisear" });
    expect(hit?.exact).toBe(false);
    expect(hit?.frame).toEqual(rowFrame);
  });
});
