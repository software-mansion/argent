import { describe, it, expect, vi } from "vitest";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// gesture-drag is the third chromium verb: swipe = touch (ios/android),
// scroll = wheel (chromium), drag = left-button mouse drag (chromium).
// These tests pin the press → interpolated moves → release sequence and
// the chromium-only capability fence.

const chromiumDevice = resolveDevice("chromium-cdp-19222");
const iosDevice = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
const androidDevice = resolveDevice("emulator-5554");

function fakeChromiumApi() {
  return {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
    dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe("gesture-drag", () => {
  it("presses at the start, interpolates moves, releases at the end (viewport px)", async () => {
    const api = fakeChromiumApi();
    const result = await gestureDragTool.execute(
      { chromium: api } as never,
      {
        udid: "chromium-cdp-19222",
        fromX: 0.25,
        fromY: 0.5,
        toX: 0.75,
        toY: 0.5,
        durationMs: 64,
      } as never
    );
    expect(result.dragged).toBe(true);

    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ type: "mousePressed", x: 0.25 * 800, y: 0.5 * 600 });
    expect(calls[calls.length - 1]).toMatchObject({
      type: "mouseReleased",
      x: 0.75 * 800,
      y: 0.5 * 600,
    });

    const moves = calls.slice(1, -1);
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      expect(move.type).toBe("mouseMoved");
      expect(move.button).toBe("left");
      // Every interpolated point stays on the straight line between the ends.
      expect(move.x as number).toBeGreaterThan(0.25 * 800);
      expect(move.x as number).toBeLessThan(0.75 * 800);
      expect(move.y).toBeCloseTo(0.5 * 600, 5);
    }
  });

  it("is chromium-only: capability gate rejects iOS and Android targets", () => {
    expect(() =>
      assertSupported("gesture-drag", gestureDragTool.capability!, chromiumDevice)
    ).not.toThrow();
    expect(() => assertSupported("gesture-drag", gestureDragTool.capability!, iosDevice)).toThrow(
      UnsupportedOperationError
    );
    expect(() =>
      assertSupported("gesture-drag", gestureDragTool.capability!, androidDevice)
    ).toThrow(UnsupportedOperationError);
  });
});
