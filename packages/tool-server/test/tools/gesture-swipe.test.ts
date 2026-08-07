import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the touch-event train the tool sends to the simulator-server. The
// momentum-free (`momentum: false`) behavior lives entirely in this event
// sequence, so asserting it is how we lock in "no fling".
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
// Platform is classified from the id's shape and the end-point repeat is gated on
// it, so the fling tests below must run on a genuinely iOS-shaped id.
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

/** Run one swipe in isolation and hand back just its own touch train. */
async function swipeTrain(
  params: Parameters<typeof gestureSwipeTool.execute>[1]
): Promise<TouchCmd[]> {
  sent.length = 0;
  await gestureSwipeTool.execute(services, params);
  return [...sent];
}

beforeEach(() => {
  sent.length = 0;
});

describe("gesture-swipe", () => {
  it("ends with a single Up and no stationary hold when momentum is on", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160 });

    expect(sent[0]).toMatchObject({ type: "Down", x: 0.5, y: 0.7 });
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // Only the single final interpolation keyframe lands exactly on the end point.
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBeLessThanOrEqual(1);
  });

  // 160ms is 10 steps, so nine interpolated Moves sit between the Down and the
  // Up. Both curves are spelled out as literal progress rather than recomputed
  // from the tool's own formula — a test that re-derives the curve cannot catch
  // a changed exponent or a flag read backwards.
  const EASED_PROGRESS = [0.271, 0.488, 0.657, 0.784, 0.875, 0.936, 0.973, 0.992, 0.999];
  const LINEAR_PROGRESS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  /** Where progress p lands on this describe's `base` vector (0.7 → 0.2). */
  const yAt = (p: number) => 0.7 - 0.5 * p;

  it("decelerates into the end point (ease-out) before lifting when momentum is off", async () => {
    const eased = await swipeTrain({ ...base, durationMs: 160, momentum: false });

    // Easing bends the path, not the end points: still one lift, still there.
    expect(eased[0]).toMatchObject({ type: "Down", x: 0.5, y: 0.7 });
    expect(eased.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(eased.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });

    // Every interpolated sample sits on 1-(1-t)^3, past its linear counterpart.
    const easedMoves = eased.slice(1, -1);
    expect(easedMoves).toHaveLength(EASED_PROGRESS.length);
    easedMoves.forEach((move, i) => {
      expect(move.y).toBeCloseTo(yAt(EASED_PROGRESS[i]), 5);
      expect(move.x).toBeCloseTo(0.5, 12);
    });

    // Per-sample travel shrinks monotonically all the way into the lift, so the
    // release velocity really decays to ~0.
    const ys = eased.map((e) => e.y);
    for (let i = 2; i < ys.length; i++) {
      expect(ys[i - 1] - ys[i]).toBeLessThan(ys[i - 2] - ys[i - 1]);
    }
    // That landing is the curve arriving, not a stationary hold (which UIKit
    // coalesces away, so the fling survives).
    expect(trailingStationaryMoves(eased, 0.5, 0.2)).toBeLessThanOrEqual(1);
    // The ease-out never overshoots: every sample stays between the end points.
    expect(ys.every((y) => y >= 0.2 - 1e-9 && y <= 0.7 + 1e-9)).toBe(true);
  });

  it("leaves a swipe with momentum on the straight linear grid, by default and by name", async () => {
    // The control for the ease-out above, run both ways round so the flag's
    // polarity is pinned from both sides rather than only where it is set.
    for (const momentum of [undefined, true]) {
      const plain = await swipeTrain({ ...base, durationMs: 160, momentum });

      const plainMoves = plain.slice(1, -1);
      expect(plainMoves).toHaveLength(LINEAR_PROGRESS.length);
      plainMoves.forEach((move, i) => {
        expect(move.y).toBeCloseTo(yAt(LINEAR_PROGRESS[i]), 5);
      });
      expect(plain.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    }
  });
});

// `settle` shipped as this flag's name with the opposite polarity, and both
// dispatch paths forward only `safeParse(...).data` — left undeclared, the
// non-strict object would strip it and run an upgrading caller's `settle: true`
// as the flinging default, green and silent.
describe("gesture-swipe retired `settle` param", () => {
  const schema = gestureSwipeTool.zodSchema!;

  it("rejects `settle: true` instead of stripping it, and names the replacement", () => {
    const parsed = schema.safeParse({ ...base, settle: true });

    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues[0];
    expect(issue.path).toEqual(["settle"]);
    // An upgrading caller has to learn the new spelling *and* the flipped sense
    // from the error alone — nothing else in the run report names the key.
    expect(issue.message).toContain("momentum: false");
  });

  it("rejects `settle: false` too — it was the shipped default, not a no-op to wave through", () => {
    const parsed = schema.safeParse({ ...base, settle: false });

    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].path).toEqual(["settle"]);
  });

  it("leaves a call that never mentions `settle` untouched", () => {
    const parsed = schema.safeParse({ ...base, momentum: false });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ ...base, momentum: false });
    expect("settle" in parsed.data!).toBe(false);
  });
});

// The Android touch backend lifts at the last Move's position and drops the Up's
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

  it("leaves the iOS train untouched — the Up alone carries the end point", async () => {
    await gestureSwipeTool.execute(services, { udid: IOS_UDID, ...across });

    // Byte-for-byte the pre-fix sequence: a duplicate sample before the lift
    // would hand UIKit an extra near-zero interval and damp the fling.
    expect(sent.map((e) => `${e.type}@${e.x.toFixed(3)}`)).toEqual([
      "Down@0.600",
      "Move@0.400",
      "Move@0.200",
      "Up@0.000",
    ]);
  });

  it("gates on platform, not device kind: a physical Android serial repeats too", async () => {
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

  it("keeps a momentum-free Android swipe exact and still lifts once", async () => {
    await gestureSwipeTool.execute(services, { udid: ANDROID_SERIAL, ...across, momentum: false });

    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    // One stationary sample at the end point — the repeat, not a hold: a train of
    // them coalesces away, leaving the fast pre-hold velocity to fling.
    expect(trailingStationaryMoves(sent, 0.0, 0.5)).toBe(1);
  });
});
