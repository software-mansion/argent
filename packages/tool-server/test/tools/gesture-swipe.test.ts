import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "@argent/registry";

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

import { gestureSwipeTool } from "../../src/tools/gesture-swipe";

const services = { simulatorServer: {} } as never;
// Platform is classified from the id's shape, so an iOS-shaped id is what proves
// the end-point repeat is not gated on platform.
const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_SERIAL = "emulator-5554";
const base = { udid: IOS_UDID, fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.2 };

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
});

describe("gesture-swipe", () => {
  it("ends with a single Up and no stationary hold when not settling", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160 });

    expect(sent[0]).toMatchObject({ type: "Down", x: 0.5, y: 0.7 });
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // One stationary sample only, the end-point repeat, not a hold train.
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBe(1);
  });

  it("decelerates into the end point (ease-out) before lifting when settling", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160, settle: true });

    // Exactly one lift, at the end point.
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // The momentum-free landing comes from a decelerating trajectory, not a
    // stationary hold (which UIKit coalesces away, so the fling survives): the
    // one stationary sample is the end-point repeat.
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBe(1);

    // Ease-out: consecutive-sample travel shrinks toward the lift, so the release
    // velocity decays to ~0. The last step is a small fraction of the first.
    const ys = sent.map((e) => e.y);
    const gaps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
    expect(gaps.at(-1)!).toBeLessThan(gaps[0]);
    // Monotonic and in-bounds: every sample sits between the start and end point.
    expect(ys.every((y) => y >= 0.2 - 1e-9 && y <= 0.7 + 1e-9)).toBe(true);
  });
});

// An ease-out needs wall clock, not samples: given less than ~150ms both OS
// velocity trackers fit the deceleration as a flick and `settle` delivers the
// opposite of what it promises. Measured against a scrollable page, durationMs
// 24 flings the content back to the top of the list on an API 34 emulator and
// 11624px forward on iOS 26.5, where the same swipe without `settle` runs
// 7345px. The combination is refused at the schema, which is where every
// dispatch path (HTTP, run-sequence, flow-execute) validates.
describe("gesture-swipe settle duration floor", () => {
  const params = { udid: IOS_UDID, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2, settle: true };

  it.each([16, 24, 100, 149])("rejects settle at durationMs %i", (durationMs) => {
    const result = gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({
      path: ["durationMs"],
      message: expect.stringContaining("settle needs durationMs of at least 150"),
    });
  });

  it("accepts settle at the floor, above it, and on the default duration", () => {
    for (const durationMs of [150, 600]) {
      expect(gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs }).success).toBe(true);
    }
    expect(gestureSwipeTool.zodSchema!.safeParse(params).success).toBe(true);
  });

  it("refuses the combination through a real dispatch, not only at the schema", async () => {
    // Registry.invokeTool validates zodSchema before it resolves services or
    // calls execute, so the refine reaches every caller and no touch is sent.
    const registry = new Registry();
    registry.registerTool(gestureSwipeTool);

    await expect(
      registry.invokeTool("gesture-swipe", { ...params, durationMs: 24 })
    ).rejects.toThrow(/settle needs durationMs of at least 150/);
    expect(sent).toHaveLength(0);
  });

  it("leaves a plain swipe free at any duration: its fling is the one asked for", () => {
    // The short-duration fling is not a `settle` artifact and is not gated. At
    // durationMs 16 the ramps are the same train (one Move, one frame), and what
    // comes back tracks the authored velocity up to the platform's own clamp.
    for (const durationMs of [1, 16, 33]) {
      expect(
        gestureSwipeTool.zodSchema!.safeParse({ ...params, settle: false, durationMs }).success
      ).toBe(true);
    }
  });
});

// Both touch backends lift at the last Move's position and drop the Up's
// coordinates, so the end point has to be sent as a Move as well or the whole
// gesture is delivered a step short — silently, with the step reporting `pass`.
describe("gesture-swipe end-point delivery", () => {
  // 0.6 leftwards over 50ms → 3 steps; unrepeated it used to arrive as 0.4.
  const across = { fromX: 0.6, fromY: 0.5, toX: 0.0, toY: 0.5, durationMs: 50 };

  it("repeats the end point as a Move before the lift on Android", async () => {
    await gestureSwipeTool.execute(services, { udid: ANDROID_SERIAL, ...across });

    expect(sent.map((e) => `${e.type}@${e.x.toFixed(3)}`)).toEqual([
      "Down@0.600",
      "Move@0.400",
      "Move@0.200",
      "Move@0.000",
      "Up@0.000",
    ]);
    // One lift only, and the Move it lifts at carries the exact end point.
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    const lift = sent.at(-2)!;
    expect(lift.x).toBeCloseTo(0.0, 12);
    expect(lift.y).toBeCloseTo(0.5, 12);
    // Down → lift is the full authored vector, not (steps-1)/steps of it.
    expect(lift.x - sent[0].x).toBeCloseTo(-0.6, 12);
  });

  it("repeats it on iOS too: the Up's coordinates are dropped there as well", async () => {
    await gestureSwipeTool.execute(services, { udid: IOS_UDID, ...across });

    // iOS drops the lift's coordinates exactly as Android does. Measured on a
    // booted iPhone 17 Pro / iOS 26.5: a Down at 0.5 / Move to 0.45 / Up at 0.25
    // train landed the lift at the Move's y (331.33px, never the 156px asked
    // for), a bare Down 0.8 / Up 0.2 pair scrolled neither Settings nor a web
    // page at all, and an unrepeated default swipe arrived 5% short (50% at
    // durationMs 32) - the shortfall tracking frame count, as it only can if
    // the lift carries no position of its own. Repeating does not cost the
    // fling: the same swipe settles a page 806px down with the repeat vs 803px
    // without (n=14 each, spread ~20px), so any effect is inside the noise.
    expect(sent.map((e) => `${e.type}@${e.x.toFixed(3)}`)).toEqual([
      "Down@0.600",
      "Move@0.400",
      "Move@0.200",
      "Move@0.000",
      "Up@0.000",
    ]);
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-2)!.x - sent[0].x).toBeCloseTo(-0.6, 12);
  });

  it("repeats for a physical device serial too, not only an emulator", async () => {
    await gestureSwipeTool.execute(services, { udid: "R5CT10ABCDE", ...across });

    expect(sent).toHaveLength(5);
    expect(sent.at(-2)!.type).toBe("Move");
    expect(sent.at(-2)!.x).toBeCloseTo(0.0, 12);
  });

  it("delivers travel the shared swipe floor gates on, at the default duration", async () => {
    // Authored magnitude 0.031 clears the 0.03 floor at parse; short-delivered it
    // arrived as 0.029, the very "silent tap instead of a swipe" the floor exists
    // to prevent.
    await gestureSwipeTool.execute(services, {
      udid: ANDROID_SERIAL,
      fromX: 0.5,
      fromY: 0.5,
      toX: 0.522,
      toY: 0.522,
    });

    const lift = sent.at(-2)!;
    const delivered = Math.hypot(lift.x - sent[0].x, lift.y - sent[0].y);
    expect(delivered).toBeCloseTo(Math.hypot(0.022, 0.022), 12);
    expect(delivered).toBeGreaterThan(0.03);
  });

  it("keeps a settling Android swipe exact and still lifts once", async () => {
    // 160ms rather than `across`'s 50: `execute` never consults the schema, but
    // the train asserted here should be one a real dispatch can reach.
    await gestureSwipeTool.execute(services, {
      udid: ANDROID_SERIAL,
      ...across,
      durationMs: 160,
      settle: true,
    });

    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    // One stationary sample at the end point — the repeat, not a hold: a train of
    // them coalesces away, leaving the fast pre-hold velocity to fling.
    expect(trailingStationaryMoves(sent, 0.0, 0.5)).toBe(1);
  });
});
