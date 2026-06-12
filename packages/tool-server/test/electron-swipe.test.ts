import { describe, it, expect, vi } from "vitest";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";

// A desktop renderer scrolls via wheel events; a mouse drag selects text
// instead. These tests pin the electron branch's mode dispatch: default
// swipes must scroll (wheel deltas, touch-platform direction convention),
// and electronMode: "drag" must produce the pressed → moved → released
// mouse sequence.

const electronUdid = "electron-cdp-19222";

function fakeElectronApi() {
  return {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
    server: { sendWheel: vi.fn().mockResolvedValue(undefined) },
    dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe("gesture-swipe on electron", () => {
  it("default mode scrolls via wheel deltas — swipe up yields positive total deltaY", async () => {
    const api = fakeElectronApi();
    const result = await gestureSwipeTool.execute(
      { electron: api } as never,
      {
        udid: electronUdid,
        fromX: 0.5,
        fromY: 0.8,
        toX: 0.5,
        toY: 0.6,
        durationMs: 64,
      } as never
    );
    expect(result.swiped).toBe(true);
    expect(api.dispatchMouseEvent).not.toHaveBeenCalled();
    const calls = api.server.sendWheel.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Wheel events land at the (normalized) start point.
    expect(calls[0]![0]).toEqual({ x: 0.5, y: 0.8 });
    const totalDx = calls.reduce((sum, c) => sum + (c[1] as number), 0);
    const totalDy = calls.reduce((sum, c) => sum + (c[2] as number), 0);
    expect(totalDx).toBeCloseTo(0, 5);
    expect(totalDy).toBeCloseTo((0.8 - 0.6) * 600, 5);
  });

  it("electronMode: 'drag' performs a mouse drag (pressed → moves → released), no wheel", async () => {
    const api = fakeElectronApi();
    const result = await gestureSwipeTool.execute(
      { electron: api } as never,
      {
        udid: electronUdid,
        fromX: 0.1,
        fromY: 0.2,
        toX: 0.4,
        toY: 0.2,
        durationMs: 48,
        electronMode: "drag",
      } as never
    );
    expect(result.swiped).toBe(true);
    expect(api.server.sendWheel).not.toHaveBeenCalled();
    const types = api.dispatchMouseEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types[0]).toBe("mousePressed");
    expect(types[types.length - 1]).toBe("mouseReleased");
    expect(types).toContain("mouseMoved");
  });
});
