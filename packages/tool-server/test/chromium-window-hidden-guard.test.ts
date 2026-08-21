import { describe, it, expect, vi } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { gestureScrollTool } from "../src/tools/gesture-scroll";

// The hidden-window guard: a minimized / fully occluded Chromium window
// throttles compositor hit-testing, so every MOUSE dispatch stalls ~5s
// (measured live on an Electron testbed). tap, drag and scroll refuse up
// front with an actionable error; keyboard skips the guard because key events
// bypass hit-testing and stay fast on hidden windows, and button never reaches
// it — its capability omits chromium. In practice the guard is a backstop:
// argent-spawned apps carry anti-throttling flags, and focus emulation pins
// reported visibility to "visible" on every session that could apply it, so the
// probe reads "hidden" only on an externally launched target whose runtime
// could not — exactly where the stall is real.

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
    expect(err.message).toMatch(/^Cannot tap: the Chromium window is hidden/);
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
    expect(err.message).toMatch(/^Cannot drag: the Chromium window is hidden/);
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
    expect(err.message).toMatch(/^Cannot scroll: the Chromium window is hidden/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_WINDOW_HIDDEN);
    // The scroll stage predates the CHROMIUM_WINDOW_HIDDEN migration, which kept
    // the spelling so rows from either side of it stay joinable.
    expect(getFailureSignal(err)?.failure_stage).toBe("chromium_scroll_window_hidden");
  });

  it("proceeds when the visibility probe rejects (mid-navigation teardown)", async () => {
    // A failed probe proves nothing about visibility; only an explicit
    // "hidden" refuses.
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

  it("proceeds when the api carries no `cdp` at all (bare tool fakes)", async () => {
    // A distinct failure mode from the rejecting-send case above: here the
    // throw is a TypeError raised while reading `.send` off `undefined`, not a
    // rejected promise. The bare fakes in chromium-drag.test.ts and
    // tools/gesture-tap.test.ts are exactly this shape, so the guard has to
    // stay transparent to them; those files only cover it incidentally, for as
    // long as neither of them grows a `cdp` key.
    const api = {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
    };
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

  // The other half of "only an explicit `hidden` refuses": a probe that resolves
  // with anything else. `Runtime.evaluate` omits `value` when the expression
  // throws an Error, and a page can redefine `visibilityState` to whatever it
  // likes, so the literal "hidden" is the only thing that is evidence of a
  // hidden window — refusing on anything else blocks a tap on a live one.
  it.each([
    ["an empty result", {}],
    ["a result with no value", { result: {} }],
    ["a value of an unexpected shape", { result: { value: null } }],
    ["a string other than `hidden`", { result: { value: "prerender" } }],
  ])("proceeds when the probe resolves with %s", async (_label, resolved) => {
    const api = fakeChromiumApi();
    api.cdp.send = vi.fn().mockResolvedValue(resolved);
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
});
