import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gestureCustomTool } from "../../src/tools/gesture-custom";
import { gestureTapTool } from "../../src/tools/gesture-tap";
import { HELD_TOUCH_TIMEOUT_MS } from "../../src/utils/held-touch";

// The real sendCommand over a recording transport, so the "a new Down lifts a
// held finger" rule in sendCommand is exercised, not mocked away.
const udid = "emulator-5554";
const touches: string[] = [];
let failNext: Error | undefined;
const api = {
  deviceId: udid,
  transport: {
    touch(opts: { type: string; x: number; y: number }) {
      touches.push(`${opts.type}@${opts.x},${opts.y}`);
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }
    },
  },
};
const services = { simulatorServer: api } as never;

type Events = Parameters<typeof gestureCustomTool.execute>[1]["events"];

describe("gesture-custom holding a finger down between calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    touches.length = 0;
    failNext = undefined;
  });
  afterEach(async () => {
    // Lift anything a test left down so state does not leak between tests.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  // Play one train through its frame delays without firing the hold timeout.
  const run = async (events: Events) => {
    const pending = gestureCustomTool.execute(services, { udid, events });
    const settled = pending.then(
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(16 * (events.length + 1));
    await settled;
    return pending;
  };

  it("returns with the finger down after a Down-only train, and a later Up lifts it", async () => {
    expect(await run([{ type: "Down", x: 0.5, y: 0.5 }])).toEqual({ events: 1, held: true });
    expect(touches).toEqual(["Down@0.5,0.5"]);

    expect(await run([{ type: "Up", x: 0.5, y: 0.5 }])).toEqual({ events: 1 });
    expect(touches).toEqual(["Down@0.5,0.5", "Up@0.5,0.5"]);

    // The release cancelled the safety timer: no second Up.
    await vi.advanceTimersByTimeAsync(HELD_TOUCH_TIMEOUT_MS);
    expect(touches).toHaveLength(2);
  });

  it("continues a held finger with Moves and stays held until an Up", async () => {
    await run([{ type: "Down", x: 0.5, y: 0.5 }]);
    expect(await run([{ type: "Move", x: 0.5, y: 0.4 }])).toEqual({ events: 1, held: true });
    expect(await run([{ type: "Up", x: 0.5, y: 0.3 }])).toEqual({ events: 1 });
    expect(touches).toEqual(["Down@0.5,0.5", "Move@0.5,0.4", "Up@0.5,0.3"]);
  });

  it("lifts a held finger after the timeout if no later train does", async () => {
    await run([{ type: "Down", x: 0.3, y: 0.4 }]);
    await vi.advanceTimersByTimeAsync(HELD_TOUCH_TIMEOUT_MS - 100);
    expect(touches).toEqual(["Down@0.3,0.4"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(touches).toEqual(["Down@0.3,0.4", "Up@0.3,0.4"]);
  });

  it("lifts a held finger before a new train starts with Down", async () => {
    await run([{ type: "Down", x: 0.2, y: 0.2 }]);
    expect(
      await run([
        { type: "Down", x: 0.6, y: 0.6 },
        { type: "Up", x: 0.6, y: 0.6 },
      ])
    ).toEqual({ events: 2 });
    expect(touches).toEqual(["Down@0.2,0.2", "Up@0.2,0.2", "Down@0.6,0.6", "Up@0.6,0.6"]);
  });

  it("lifts a held finger before another tool's Down, and the timer does not fire later", async () => {
    await run([{ type: "Down", x: 0.2, y: 0.2 }]);
    const tap = gestureTapTool.execute(services, { udid, x: 0.7, y: 0.7 }, undefined as never);
    await vi.advanceTimersByTimeAsync(500);
    await tap;
    expect(touches).toEqual(["Down@0.2,0.2", "Up@0.2,0.2", "Down@0.7,0.7", "Up@0.7,0.7"]);
    await vi.advanceTimersByTimeAsync(HELD_TOUCH_TIMEOUT_MS);
    expect(touches).toHaveLength(4);
  });

  it("lifts the held finger when a continuing train fails", async () => {
    await run([{ type: "Down", x: 0.5, y: 0.5 }]);
    failNext = new Error("socket closed");
    await expect(run([{ type: "Move", x: 0.5, y: 0.4 }])).rejects.toThrow("socket closed");
    expect(touches).toEqual(["Down@0.5,0.5", "Move@0.5,0.4", "Up@0.5,0.5"]);
  });
});
