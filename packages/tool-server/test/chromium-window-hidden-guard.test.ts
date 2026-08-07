import { describe, it, expect, vi } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { gestureScrollTool } from "../src/tools/gesture-scroll";
import { makeChromiumImpl as makeKeyboardChromiumImpl } from "../src/tools/keyboard/platforms/chromium";

// The hidden-window guard: a minimized / fully occluded Chromium window
// throttles compositor hit-testing, so every MOUSE dispatch stalls ~5s
// (measured live on an Electron testbed). tap, drag and scroll refuse up
// front with an actionable error; keyboard/button skip the guard because key
// events bypass hit-testing and stay fast on hidden windows. In practice the
// guard is a backstop: primePageSession's focus emulation pins reported
// visibility to "visible" while a session is attached, so the probe reads
// "hidden" only on sessions where emulation could not be applied — exactly
// where the stall is real.

function fakeChromiumApi(visibility = "visible") {
  return {
    getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
    dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
    server: { sendWheel: vi.fn().mockResolvedValue(undefined) },
    cdp: { send: vi.fn().mockResolvedValue({ result: { value: visibility } }) },
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<FailureError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FailureError);
    return err as FailureError;
  }
  throw new Error("expected the tool to refuse on a hidden window");
}

describe("hidden-window guard on chromium mouse tools", () => {
  it("gesture-tap refuses before dispatching any mouse event", async () => {
    const api = fakeChromiumApi("hidden");
    const err = await captureFailure(
      gestureTapTool.execute(
        { chromium: api } as never,
        {
          udid: "chromium-cdp-19222",
          x: 0.5,
          y: 0.5,
        } as never
      )
    );
    expect(err.message).toMatch(/hidden/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_WINDOW_HIDDEN);
    expect(getFailureSignal(err)?.failure_stage).toBe("chromium_tap_window_hidden");
    expect(api.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it("gesture-drag refuses before pressing the mouse button", async () => {
    const api = fakeChromiumApi("hidden");
    const err = await captureFailure(
      gestureDragTool.execute(
        { chromium: api } as never,
        {
          udid: "chromium-cdp-19222",
          fromX: 0.2,
          fromY: 0.5,
          toX: 0.8,
          toY: 0.5,
        } as never
      )
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_WINDOW_HIDDEN);
    expect(getFailureSignal(err)?.failure_stage).toBe("chromium_drag_window_hidden");
    expect(api.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it("gesture-scroll reports the dedicated failure code (migrated off CHROMIUM_INPUT_INVALID)", async () => {
    const api = fakeChromiumApi("hidden");
    const err = await captureFailure(
      gestureScrollTool.execute(
        { chromium: api } as never,
        {
          udid: "chromium-cdp-19222",
          x: 0.5,
          y: 0.5,
          deltaY: 0.25,
        } as never
      )
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_WINDOW_HIDDEN);
    // The stage string is unchanged so old and new telemetry stay joinable.
    expect(getFailureSignal(err)?.failure_stage).toBe("chromium_scroll_window_hidden");
  });

  it("proceeds when the visibility probe rejects (mid-navigation, bare test fakes)", async () => {
    // A failed probe proves nothing about visibility; only an explicit
    // "hidden" refuses. This also covers api objects with no `cdp` at all.
    const api = fakeChromiumApi();
    api.cdp.send = vi.fn().mockRejectedValue(new Error("Execution context was destroyed"));
    const result = (await gestureTapTool.execute(
      { chromium: api } as never,
      {
        udid: "chromium-cdp-19222",
        x: 0.5,
        y: 0.5,
      } as never
    )) as { tapped: boolean };
    expect(result.tapped).toBe(true);
    expect(api.dispatchMouseEvent).toHaveBeenCalled();
  });

  it("keyboard types on a hidden window — the guard's absence there is deliberate", async () => {
    // Key events skip compositor hit-testing: measured on a genuinely
    // minimized Electron window, Input.dispatchKeyEvent returns in 1-14ms
    // while mouse dispatches stall ~5s each. Adding the guard to keyboard
    // would refuse input that demonstrably works, so this test pins the
    // exemption: an api whose visibility probe WOULD report "hidden" must
    // still type, and the probe must never even be consulted. (button has no
    // chromium branch at all, so keyboard is the only tool to pin.)
    const api = fakeChromiumApi("hidden") as ReturnType<typeof fakeChromiumApi> & {
      dispatchKeyEvent: ReturnType<typeof vi.fn>;
    };
    api.dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const registry = { resolveService: vi.fn(async () => api) };

    const result = await makeKeyboardChromiumImpl(registry as never).handler(
      {},
      { udid: "chromium-cdp-19222", text: "hi", delayMs: 0 },
      { id: "chromium-cdp-19222", platform: "chromium", kind: "app" } as never
    );

    expect(result.typed).toBe("hi");
    expect(api.dispatchKeyEvent).toHaveBeenCalled();
    expect(api.cdp.send).not.toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ expression: "document.visibilityState" })
    );
  });
});
