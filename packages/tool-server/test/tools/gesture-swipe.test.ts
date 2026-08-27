import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "@argent/registry";

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
// Runs after each dispatch is recorded, so the abort tests below can cancel on
// an exact event index rather than racing the 16ms frame timer.
let afterSend: ((count: number) => void) | undefined;
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
    afterSend?.(sent.length);
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
  afterSend = undefined;
});

describe("gesture-swipe", () => {
  it("ends with a single Up and no stationary hold when momentum is on", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160 });

    expect(sent[0]).toMatchObject({ type: "Down", x: 0.5, y: 0.7 });
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // One stationary sample only, the end-point repeat, not a hold train.
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBe(1);
  });

  // 160ms is 10 steps, so nine interpolated Moves sit between the Down and the
  // Up. Both curves are literal progress rather than recomputed from the tool's
  // formula - a test that re-derives it cannot catch a changed exponent.
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

    // Every interpolated sample sits on 1-(1-t)^3, past its linear counterpart;
    // the train then repeats the end point as the unconditional pre-lift Move.
    const easedMoves = eased.slice(1, -2);
    expect(easedMoves).toHaveLength(EASED_PROGRESS.length);
    easedMoves.forEach((move, i) => {
      expect(move.y).toBeCloseTo(yAt(EASED_PROGRESS[i]), 5);
      expect(move.x).toBeCloseTo(0.5, 12);
    });
    expect(eased.at(-2)).toMatchObject({ type: "Move", x: 0.5, y: 0.2 });

    // Per-sample travel shrinks monotonically all the way into the lift, so the
    // release velocity really decays to ~0.
    const ys = eased.map((e) => e.y);
    for (let i = 2; i < ys.length; i++) {
      expect(ys[i - 1] - ys[i]).toBeLessThan(ys[i - 2] - ys[i - 1]);
    }
    // That landing is the curve arriving, not a stationary hold (which UIKit
    // coalesces away, so the fling survives): the one stationary sample is the
    // end-point repeat.
    expect(trailingStationaryMoves(eased, 0.5, 0.2)).toBe(1);
    // The ease-out never overshoots: every sample stays between the end points.
    expect(ys.every((y) => y >= 0.2 - 1e-9 && y <= 0.7 + 1e-9)).toBe(true);
  });

  it("leaves a swipe with momentum on the straight linear grid, by default and by name", async () => {
    // The control for the ease-out above, run both ways so the flag's polarity
    // is pinned from both sides.
    for (const momentum of [undefined, true]) {
      const plain = await swipeTrain({ ...base, durationMs: 160, momentum });

      const plainMoves = plain.slice(1, -2);
      expect(plainMoves).toHaveLength(LINEAR_PROGRESS.length);
      plainMoves.forEach((move, i) => {
        expect(move.y).toBeCloseTo(yAt(LINEAR_PROGRESS[i]), 5);
      });
      // The pre-lift end-point repeat is unconditional, so it shows up here too.
      expect(plain.at(-2)).toMatchObject({ type: "Move", x: 0.5, y: 0.2 });
      expect(plain.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    }
  });
});

// An ease-out needs wall clock, not samples: given less than ~150ms both OS
// velocity trackers fit the deceleration as a flick and `momentum: false`
// delivers the opposite of what it promises - on Android, a fling back to the
// top of the list. Refused at the schema, where every dispatch path validates.
describe("gesture-swipe momentum-free duration floor", () => {
  const params = { udid: IOS_UDID, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2, momentum: false };

  it.each([16, 24, 100, 149])("rejects momentum: false at durationMs %i", (durationMs) => {
    const result = gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({
      path: ["durationMs"],
      message: expect.stringContaining("momentum: false needs durationMs of at least 150"),
    });
  });

  it("accepts momentum: false at the floor, above it, and on the default duration", () => {
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
    ).rejects.toThrow(/momentum: false needs durationMs of at least 150/);
    expect(sent).toHaveLength(0);
  });

  it("leaves a plain swipe free at any duration: its fling is the one asked for", () => {
    // The short-duration fling is not a momentum-free artifact and is not gated:
    // what comes back tracks the authored velocity up to the platform's own clamp.
    for (const durationMs of [1, 16, 33]) {
      expect(
        gestureSwipeTool.zodSchema!.safeParse({ ...params, momentum: true, durationMs }).success
      ).toBe(true);
    }
  });
});

// `settle` shipped as this flag's name with the opposite polarity, and both
// dispatch paths forward only `safeParse(...).data` — left undeclared, the
// non-strict object would strip an upgrading caller's `settle: true` and run the
// flinging default, green and silent.
describe("gesture-swipe retired `settle` param", () => {
  const schema = gestureSwipeTool.zodSchema!;

  it("rejects `settle: true` instead of stripping it, and names the replacement", () => {
    const parsed = schema.safeParse({ ...base, settle: true });

    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues[0];
    expect(issue.path).toEqual(["settle"]);
    // The error is the only place the new spelling and the flipped sense appear.
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

    // iOS drops the lift's coordinates exactly as Android does. Measured on iOS
    // 26.5: a Down 0.5 / Move 0.45 / Up 0.25 train lifted at the Move's y, and an
    // unrepeated default swipe arrived 5% short (50% at durationMs 32) - the
    // shortfall tracking frame count, as it only can if the lift carries no
    // position of its own.
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
    // arrived as 0.029, the silent tap the floor exists to prevent.
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
    // 160ms rather than `across`'s 50: `execute` never consults the schema, but
    // the train asserted here should be one a real dispatch can reach.
    await gestureSwipeTool.execute(services, {
      udid: ANDROID_SERIAL,
      ...across,
      durationMs: 160,
      momentum: false,
    });

    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    // One stationary sample at the end point — the repeat, not a hold: a train of
    // them coalesces away, leaving the fast pre-hold velocity to fling.
    expect(trailingStationaryMoves(sent, 0.0, 0.5)).toBe(1);
  });
});

// Every frame is a real 16ms sleep with the finger down, so a cancelled run that
// never consults the signal keeps driving the device for the rest of its
// duration, interleaving its samples into every later gesture until the
// tool-server is restarted. Same contract as gesture-rotate's, tested the same
// way (see gesture-rotate-radius.test.ts).
describe("gesture-swipe abort", () => {
  // 300 steps → 301 frames if it ever ran to completion.
  const long = { ...base, durationMs: 4800 };

  it("lifts the finger where it is and rejects when aborted mid-gesture", async () => {
    const controller = new AbortController();
    // Abort synchronously from inside the send hook after the 3rd dispatched
    // event - deterministic, no real-time races.
    afterSend = (count) => {
      if (count === 3) controller.abort();
    };

    await expect(
      gestureSwipeTool.execute(services, long, { signal: controller.signal } as never)
    ).rejects.toThrow(/gesture-swipe aborted - cancelled mid-gesture after 3 of 301 frames/);

    // Down + 2 Moves before the abort lands, then only the terminal Up.
    expect(sent.map((e) => e.type)).toEqual(["Down", "Move", "Move", "Up"]);
    // The lift is at the last dispatched sample: teleporting to the end point
    // would deliver the travel the caller cancelled.
    expect(sent.at(-1)).toMatchObject({ x: sent.at(-2)!.x, y: sent.at(-2)!.y });
    expect(sent.at(-1)!.y).toBeGreaterThan(base.toY);
  });

  it("lifts instead of completing when the abort lands on the final frame", async () => {
    // 3 steps, so the 4th and last frame would dispatch the end-point Move and
    // the Up. `i <= steps` puts that frame inside the checked loop, where
    // gesture-drag's `i < steps` needs a check after its own.
    const controller = new AbortController();
    afterSend = (count) => {
      if (count === 3) controller.abort();
    };

    await expect(
      gestureSwipeTool.execute(services, { ...base, durationMs: 48 }, {
        signal: controller.signal,
      } as never)
    ).rejects.toThrow(/gesture-swipe aborted - cancelled mid-gesture after 3 of 4 frames/);

    expect(sent.map((e) => e.type)).toEqual(["Down", "Move", "Move", "Up"]);
    // Lifted where the finger was; the authored end point never arrives.
    expect(sent.at(-1)).toMatchObject({ x: sent.at(-2)!.x, y: sent.at(-2)!.y });
    expect(sent.at(-1)!.y).toBeGreaterThan(base.toY);
  });

  it("puts no finger down at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      gestureSwipeTool.execute(services, long, { signal: controller.signal } as never)
    ).rejects.toThrow(/gesture-swipe aborted - cancelled mid-gesture after 0 of 301 frames/);
    expect(sent).toEqual([]);
  });

  it("runs to completion on a signal that never aborts", async () => {
    const controller = new AbortController();

    const result = await gestureSwipeTool.execute(services, { ...base, durationMs: 48 }, {
      signal: controller.signal,
    } as never);

    expect(result.swiped).toBe(true);
    expect(sent.map((e) => e.type)).toEqual(["Down", "Move", "Move", "Move", "Up"]);
  });
});

// Not about delivery fidelity - a 60s swipe is delivered exactly as authored -
// but about what authoring it costs: durationMs is wall clock the call spends AND
// wall clock the device spends under a touch. On the schema rather than only on
// the flow directive, because the tool is dispatched directly from HTTP, MCP,
// run-sequence and the CLI.
describe("gesture-swipe duration ceiling", () => {
  const params = { udid: IOS_UDID, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 };

  it.each([10_001, 20_000, 1e21])("rejects durationMs %p", (durationMs) => {
    const result = gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({
      path: ["durationMs"],
      message: expect.stringContaining("durationMs must be at most 10000"),
    });
  });

  it("rejects a non-finite durationMs, which no ordering of the bound catches", () => {
    // Math.round(Infinity / 16) is Infinity, so the frame loop never ends;
    // Math.max(1, NaN) is NaN, so `i <= NaN` is false at once and the tool reports
    // a swipe it never sent.
    for (const durationMs of [Infinity, -Infinity, NaN]) {
      expect(gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs }).success).toBe(false);
    }
  });

  it("accepts the exact ceiling, the default, and what scroll-to dispatches", () => {
    for (const durationMs of [10_000, 600, 300, 16]) {
      expect(gestureSwipeTool.zodSchema!.safeParse({ ...params, durationMs }).success).toBe(true);
    }
    expect(gestureSwipeTool.zodSchema!.safeParse(params).success).toBe(true);
  });

  it("refuses it through a real dispatch, so no touch reaches the device", async () => {
    const registry = new Registry();
    registry.registerTool(gestureSwipeTool);

    await expect(
      registry.invokeTool("gesture-swipe", { ...params, durationMs: 1e21 })
    ).rejects.toThrow(/durationMs must be at most 10000/);
    expect(sent).toHaveLength(0);
  });
});

// The ease-out rides on the interpolated Moves: steps = max(1, round(duration/16))
// and a Move is emitted only for 0 < i < steps, so 23ms is 1 step (nothing eased)
// and 24ms is 2, for exactly one eased sample. Unreachable through the schema, so
// this pins execute's own arithmetic. The eased sample is told apart by position:
// the cubic puts it at 87.5% of the travel, never on the end point.
describe("gesture-swipe interpolated-Move boundary", () => {
  const across = { fromX: 0.6, fromY: 0.5, toX: 0.0, toY: 0.5, momentum: false };

  // Ordered title-first: the leading %s/%d/%d name the case, the rest is fixture.
  it.each([
    ["iOS", 23, 0, IOS_UDID, ["Down@0.600", "Move@0.000", "Up@0.000"]],
    ["iOS", 24, 1, IOS_UDID, ["Down@0.600", "Move@0.075", "Move@0.000", "Up@0.000"]],
    ["Android", 23, 0, ANDROID_SERIAL, ["Down@0.600", "Move@0.000", "Up@0.000"]],
    ["Android", 24, 1, ANDROID_SERIAL, ["Down@0.600", "Move@0.075", "Move@0.000", "Up@0.000"]],
  ] as const)(
    "%s at durationMs %d eases %d interpolated Move(s)",
    async (_device, durationMs, eased, udid, train) => {
      const events = await swipeTrain({ ...across, udid, durationMs });

      expect(events.map((e) => `${e.type}@${e.x.toFixed(3)}`)).toEqual(train);
      // A Move away from the end point is an eased sample, the one on it is the
      // repeat.
      expect(events.filter((e) => e.type === "Move" && e.x !== across.toX)).toHaveLength(eased);
    }
  );
});
