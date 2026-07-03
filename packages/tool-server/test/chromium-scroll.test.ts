import { describe, it, expect, vi } from "vitest";
import { gestureScrollTool } from "../src/tools/gesture-scroll";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// The scroll/swipe split: a desktop renderer scrolls with wheel events
// (gesture-scroll, chromium-only) while touch platforms scroll with a drag
// gesture (gesture-swipe, ios/android-only). These tests pin both the wheel
// dispatch math and the capability fence between the two tools.

const chromiumDevice = resolveDevice("chromium-cdp-19222");
const iosDevice = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
const androidDevice = resolveDevice("emulator-5554");

function fakeChromiumApi(visibility = "visible") {
  return {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
    server: { sendWheel: vi.fn().mockResolvedValue(undefined) },
    cdp: { send: vi.fn().mockResolvedValue({ result: { value: visibility } }) },
  };
}

describe("gesture-scroll", () => {
  it("dispatches chunked wheel deltas at the anchor point, totalling the requested fraction", async () => {
    const api = fakeChromiumApi();
    const result = await gestureScrollTool.execute(
      { chromium: api } as never,
      { udid: "chromium-cdp-19222", x: 0.5, y: 0.65, deltaY: 0.25, durationMs: 64 } as never
    );
    expect(result.scrolled).toBe(true);
    const calls = api.server.sendWheel.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]![0]).toEqual({ x: 0.5, y: 0.65 });
    const totalDx = calls.reduce((sum, c) => sum + (c[1] as number), 0);
    const totalDy = calls.reduce((sum, c) => sum + (c[2] as number), 0);
    expect(totalDx).toBeCloseTo(0, 5);
    expect(totalDy).toBeCloseTo(0.25 * 600, 5);
  });

  it("supports horizontal and negative (scroll-back-up) deltas", async () => {
    const api = fakeChromiumApi();
    await gestureScrollTool.execute(
      { chromium: api } as never,
      {
        udid: "chromium-cdp-19222",
        x: 0.5,
        y: 0.5,
        deltaX: 0.1,
        deltaY: -0.5,
        durationMs: 32,
      } as never
    );
    const calls = api.server.sendWheel.mock.calls;
    const totalDx = calls.reduce((sum, c) => sum + (c[1] as number), 0);
    const totalDy = calls.reduce((sum, c) => sum + (c[2] as number), 0);
    expect(totalDx).toBeCloseTo(0.1 * 800, 5);
    expect(totalDy).toBeCloseTo(-0.5 * 600, 5);
  });

  it("fails fast with an actionable error when the window is hidden", async () => {
    // A hidden window halts the input pipeline: wheel dispatches would stall
    // past the CDP timeout, so the tool must refuse before dispatching any.
    const api = fakeChromiumApi("hidden");
    await expect(
      gestureScrollTool.execute(
        { chromium: api } as never,
        { udid: "chromium-cdp-19222", x: 0.5, y: 0.5, deltaY: 0.25 } as never
      )
    ).rejects.toThrow(/hidden/);
    expect(api.server.sendWheel).not.toHaveBeenCalled();
  });

  it("schema rejects a scroll with no delta", () => {
    const parsed = gestureScrollTool.zodSchema!.safeParse({
      udid: "chromium-cdp-19222",
      x: 0.5,
      y: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("is chromium-only: capability gate rejects iOS and Android targets", () => {
    expect(() =>
      assertSupported("gesture-scroll", gestureScrollTool.capability!, chromiumDevice)
    ).not.toThrow();
    expect(() =>
      assertSupported("gesture-scroll", gestureScrollTool.capability!, iosDevice)
    ).toThrow(UnsupportedOperationError);
    expect(() =>
      assertSupported("gesture-scroll", gestureScrollTool.capability!, androidDevice)
    ).toThrow(UnsupportedOperationError);
  });
});

describe("gesture-swipe chromium lockout", () => {
  it("no longer declares chromium support — the gate names the tool clearly", () => {
    expect(gestureSwipeTool.capability).not.toHaveProperty("chromium");
    expect(() =>
      assertSupported("gesture-swipe", gestureSwipeTool.capability!, chromiumDevice)
    ).toThrow(/gesture-swipe.*not supported on chromium/);
  });
});
