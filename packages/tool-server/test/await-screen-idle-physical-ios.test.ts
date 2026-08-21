import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../src/tools/describe/contract";

/**
 * The CoreDevice read returns at most `PHYSICAL_IOS_AX_LIMIT` elements, starting
 * at the device's VoiceOver cursor and advancing it one step per read. Below the
 * ceiling that is a rotation of one set, which the sorted signature cancels;
 * at or above it, consecutive reads are windows over *different parts* of the
 * screen and no signature can equate them. Left to poll, a screen that never
 * moved burns the whole 15s budget and comes back `settled: false` with nothing
 * said about why.
 */
const LIMIT = 120;
let total = LIMIT + 1;
let cursor = 0;

const describeIos = vi.fn(async (): Promise<DescribeTreeData> => {
  const all = Array.from({ length: total }, (_, i) => `Row ${i}`);
  const size = Math.min(total, LIMIT);
  const window = Array.from({ length: size }, (_, k) => all[(cursor + k) % total]!);
  cursor = (cursor + 1) % total;
  return {
    source: "coredevice-ax",
    tree: {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: window.map((label, i) => ({
        role: "AXButton",
        label,
        frame: { x: 0.04, y: i / size, width: 0.92, height: 0.05 },
        children: [],
      })),
    },
  };
});
vi.mock("../src/tools/describe/platforms/ios", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  describeIos: (...a: unknown[]) => describeIos(...(a as [])),
  iosRequires: [],
}));
vi.mock("../src/utils/ios-devices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isTvOsSimulator: async () => false,
}));

// A physical Android phone is `kind: "device"` too, so it is the control for
// every `platform === "ios" && kind === "device"` narrowing in this tool.
const describeAndroid = vi.fn();
vi.mock("../src/tools/describe/platforms/android", () => ({
  describeAndroid: (...a: unknown[]) => describeAndroid(...(a as [])),
  androidRequires: [],
}));
vi.mock("../src/utils/adb", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isAndroidTv: async () => false,
}));

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";

const tool = createAwaitScreenIdleTool({} as unknown as Registry);
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";

async function run(elements: number) {
  total = elements;
  cursor = 0;
  const p = tool.execute({}, { udid: PHYSICAL_UDID } as never) as Promise<{
    settled: boolean;
    waitedMs: number;
    polls: number;
    note?: string;
  }>;
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

beforeEach(() => {
  describeIos.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("await-screen-idle against a still physical-iPhone screen", () => {
  it("settles while the whole screen fits in one read, up to and including the limit", async () => {
    // A full read only says "at least this many", so a screen of exactly the
    // limit cannot be told from a larger one on any single poll — and it settles
    // correctly, because its window IS the whole set. Refusing on a full read
    // would break this case.
    for (const n of [LIMIT - 50, LIMIT - 1, LIMIT]) {
      const r = await run(n);
      expect(r.settled, `${n} elements`).toBe(true);
      expect(r.note, `${n} elements`).toBeUndefined();
    }
  });

  it("explains a wait that ran out after a full read, rather than a bare false", async () => {
    const r = await run(LIMIT + 1);
    expect(r.settled).toBe(false);
    expect(r.note, "a bare settled:false gives the caller nothing to act on").toMatch(
      /cannot be decided/i
    );
    expect(r.note).toMatch(/screenshot/);
  });

  it("leaves a physical ANDROID phone on the ordinary signature", async () => {
    // `rotatingRead` narrows on platform AND kind, and a physical Android phone
    // is also `kind: "device"`. Dropping the platform half would give Android
    // the order- and frame-free signature — which stops catching an animation
    // that only moves things — and the CoreDevice truncation refusal, on a tree
    // that has neither problem.
    const rows = LIMIT + 5;
    describeAndroid.mockImplementation(async () => ({
      source: "uiautomator",
      tree: {
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: Array.from({ length: rows }, (_, i) => ({
          role: "AXButton",
          label: `Row ${i}`,
          frame: { x: 0.04, y: i / rows, width: 0.92, height: 0.05 },
          children: [],
        })),
      },
    }));
    const p = tool.execute({}, { udid: "R5CT30ABCDE" } as never) as Promise<{
      settled: boolean;
      note?: string;
    }>;
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    const r = await p;
    expect(r.note, "the CoreDevice element ceiling is not Android's").toBeUndefined();
    expect(r.settled).toBe(true);
  });

  it("leaves a simulator's tree alone, however large", async () => {
    // The ceiling is a property of the CoreDevice read, not of describe: an
    // iOS-simulator tree of the same size must still settle.
    total = LIMIT + 50;
    cursor = 0;
    describeIos.mockImplementationOnce(async () => ({
      source: "ax-service",
      tree: {
        role: "AXGroup",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: Array.from({ length: LIMIT + 50 }, (_, i) => ({
          role: "AXButton",
          label: `Row ${i}`,
          frame: { x: 0.04, y: i / (LIMIT + 50), width: 0.92, height: 0.05 },
          children: [],
        })),
      },
    }));
    const p = tool.execute({}, {
      udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    } as never) as Promise<{ settled: boolean; note?: string }>;
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    const r = await p;
    expect(r.note).toBeUndefined();
  });
});
