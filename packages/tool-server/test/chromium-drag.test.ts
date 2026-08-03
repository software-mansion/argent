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

  it("settle: true eases the moves out (release at ~0 pointer velocity); without it they stay linear", async () => {
    // durationMs 64 → 4 steps → moves at t = 0.25, 0.5, 0.75. Web drag
    // libraries compute their fling from the release velocity of this very
    // mouse stream, so the eased curve must genuinely decay into the release.
    const params = { udid: "chromium-cdp-19222", fromX: 0.25, fromY: 0.5, toX: 0.75, toY: 0.5 };
    const startPx = 0.25 * 800;
    const deltaPx = (0.75 - 0.25) * 800;

    const settled = fakeChromiumApi();
    await gestureDragTool.execute(
      { chromium: settled } as never,
      { ...params, durationMs: 64, settle: true } as never
    );
    const settledCalls = settled.dispatchMouseEvent.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    // Endpoints are untouched by the easing — only the path between changes.
    expect(settledCalls[0]).toMatchObject({ type: "mousePressed", x: startPx });
    expect(settledCalls[settledCalls.length - 1]).toMatchObject({
      type: "mouseReleased",
      x: 0.75 * 800,
    });
    const settledMoves = settledCalls.slice(1, -1);
    expect(settledMoves).toHaveLength(3);
    // 1-(1-t)^3 at t = 0.25, 0.5, 0.75 — each point past its linear counterpart.
    expect(settledMoves[0].x as number).toBeCloseTo(startPx + deltaPx * 0.578125, 5);
    expect(settledMoves[1].x as number).toBeCloseTo(startPx + deltaPx * 0.875, 5);
    expect(settledMoves[2].x as number).toBeCloseTo(startPx + deltaPx * 0.984375, 5);
    // Per-frame step size shrinks monotonically all the way into the release.
    const xs = settledCalls.map((c) => c.x as number);
    for (let i = 2; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeLessThan(xs[i - 1] - xs[i - 2]);
    }

    const control = fakeChromiumApi();
    await gestureDragTool.execute(
      { chromium: control } as never,
      { ...params, durationMs: 64 } as never
    );
    const controlMoves = control.dispatchMouseEvent.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .slice(1, -1);
    expect(controlMoves).toHaveLength(3);
    // Without settle the same endpoints interpolate on the straight linear grid.
    expect(controlMoves[0].x as number).toBeCloseTo(startPx + deltaPx * 0.25, 5);
    expect(controlMoves[1].x as number).toBeCloseTo(startPx + deltaPx * 0.5, 5);
    expect(controlMoves[2].x as number).toBeCloseTo(startPx + deltaPx * 0.75, 5);
  });

  it("clamps a normalized 1.0 endpoint to the last addressable pixel so the release stays in the viewport", async () => {
    // The flow swipe directive saturates `by` deltas to [0, 1], so a 1.0
    // endpoint is routine — unclamped it maps to pixel == width/height, one
    // past the viewport, and Chromium delivers no pointerup to the page.
    const api = fakeChromiumApi();
    const result = await gestureDragTool.execute(
      { chromium: api } as never,
      {
        udid: "chromium-cdp-19222",
        fromX: 0.5,
        fromY: 0.5,
        toX: 1.0,
        toY: 1.0,
        durationMs: 64,
      } as never
    );
    expect(result.dragged).toBe(true);

    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // Press, every interpolated move, and the release all stay addressable.
    for (const call of calls) {
      expect(call.x as number).toBeLessThanOrEqual(800 - 1);
      expect(call.y as number).toBeLessThanOrEqual(600 - 1);
    }
    expect(calls[calls.length - 1]).toMatchObject({
      type: "mouseReleased",
      x: 800 - 1,
      y: 600 - 1,
    });
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
