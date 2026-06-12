import { describe, it, expect, vi } from "vitest";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// gesture-drag is the third electron verb: swipe = touch (ios/android),
// scroll = wheel (electron), drag = left-button mouse drag (electron).
// These tests pin the press → interpolated moves → release sequence and
// the electron-only capability fence.

const electronDevice = resolveDevice("electron-cdp-19222");
const iosDevice = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
const androidDevice = resolveDevice("emulator-5554");

function fakeElectronApi() {
  return {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
    dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe("gesture-drag", () => {
  it("presses at the start, interpolates moves, releases at the end (viewport px)", async () => {
    const api = fakeElectronApi();
    const result = await gestureDragTool.execute(
      { electron: api } as never,
      {
        udid: "electron-cdp-19222",
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

  it("is electron-only: capability gate rejects iOS and Android targets", () => {
    expect(() =>
      assertSupported("gesture-drag", gestureDragTool.capability!, electronDevice)
    ).not.toThrow();
    expect(() => assertSupported("gesture-drag", gestureDragTool.capability!, iosDevice)).toThrow(
      UnsupportedOperationError
    );
    expect(() =>
      assertSupported("gesture-drag", gestureDragTool.capability!, androidDevice)
    ).toThrow(UnsupportedOperationError);
  });
});
