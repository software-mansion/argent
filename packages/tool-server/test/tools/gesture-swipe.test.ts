import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the touch-event train the tool sends to the simulator-server. The
// momentum-free (`settle`) behavior lives entirely in this event sequence, so
// asserting it is how we lock in "no fling".
interface TouchCmd {
  cmd: string;
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
}
const sent: TouchCmd[] = [];
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
  },
}));

// Stub the delivery-verification entry point: the tool passes the caller's
// `verify` through, runs the injection via the action, and spreads the returned
// check into its result. The policy itself is unit-tested in
// touch-verification.test.ts.
type Check = { verified?: boolean; warning?: string };
let mockCheck: Check = {};
const runWithDeliveryVerificationMock = vi.fn(
  async (_api: unknown, _verify: boolean | undefined, action: () => Promise<void>) => {
    await action();
    return mockCheck;
  }
);
vi.mock("../../src/utils/touch-verification", () => ({
  runWithDeliveryVerification: (
    api: unknown,
    verify: boolean | undefined,
    action: () => Promise<void>
  ) => runWithDeliveryVerificationMock(api, verify, action),
  describeVerify: (noun: string) => `verify ${noun}`,
}));

import { gestureSwipeTool } from "../../src/tools/gesture-swipe";

const services = { simulatorServer: {} } as never;
const base = { udid: "X", fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.2 };

/** Length of the trailing run of stationary Moves at the end point before Up. */
function trailingStationaryMoves(events: TouchCmd[], x: number, y: number): number {
  let count = 0;
  for (let i = events.length - 2; i >= 0; i--) {
    const e = events[i];
    if (e.type === "Move" && e.x === x && e.y === y) count++;
    else break;
  }
  return count;
}

beforeEach(() => {
  sent.length = 0;
  mockCheck = {};
  runWithDeliveryVerificationMock.mockClear();
});

describe("gesture-swipe", () => {
  it("ends with a single Up and no stationary hold when not settling", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160 });

    expect(sent[0]).toMatchObject({ type: "Down", x: 0.5, y: 0.7 });
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // Only the single final interpolation keyframe lands exactly on the end point.
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBeLessThanOrEqual(1);
  });

  it("decelerates into the end point (ease-out) before lifting when settling", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160, settle: true });

    // Exactly one lift, at the end point.
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // The momentum-free landing comes from a decelerating trajectory, not a
    // stationary hold (which UIKit coalesces away, so the fling survives).
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBeLessThanOrEqual(1);

    // Ease-out: consecutive-sample travel shrinks toward the lift, so the release
    // velocity decays to ~0. The last step is a small fraction of the first.
    const ys = sent.map((e) => e.y);
    const gaps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
    expect(gaps.at(-1)!).toBeLessThan(gaps[0]);
    // Monotonic and in-bounds: every sample sits between the start and end point.
    expect(ys.every((y) => y >= 0.2 - 1e-9 && y <= 0.7 + 1e-9)).toBe(true);
  });
});

describe("gesture-swipe delivery verification", () => {
  it("routes every swipe through the verification wrapper with the caller's verify flag", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 64 });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      undefined, // automatic first-touch policy
      expect.any(Function)
    );

    await gestureSwipeTool.execute(services, { ...base, durationMs: 64, verify: true });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      true,
      expect.any(Function)
    );
  });

  it("spreads the delivery check into the result while still injecting the swipe", async () => {
    mockCheck = { verified: false, warning: "warn:no-change" };
    const result = await gestureSwipeTool.execute(services, {
      ...base,
      durationMs: 64,
      verify: true,
    });
    // The swipe was still sent; the result reports the failed delivery.
    expect(sent[0]?.type).toBe("Down");
    expect(sent.at(-1)?.type).toBe("Up");
    expect(result.swiped).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.warning).toBe("warn:no-change");
  });

  it("returns a bare result when no check ran", async () => {
    mockCheck = {};
    const result = await gestureSwipeTool.execute(services, { ...base, durationMs: 64 });
    expect(result.swiped).toBe(true);
    expect(result.verified).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });
});
