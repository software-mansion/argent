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

  it("holds with a train of stationary Move samples before lifting when settling", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 160, settle: true });

    // Exactly one lift, at the end point.
    expect(sent.filter((e) => e.type === "Up")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: "Up", x: 0.5, y: 0.2 });
    // A real hold: several zero-displacement Move samples at the end point feed
    // the velocity tracker before the lift, so iOS reads ~0 velocity (no fling).
    expect(trailingStationaryMoves(sent, 0.5, 0.2)).toBeGreaterThanOrEqual(4);
  });
});
