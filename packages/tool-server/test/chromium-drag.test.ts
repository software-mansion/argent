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
    // The real ChromiumCdpApi always carries the raw CDP client; the tool's
    // visibility guard probes document.visibilityState through it.
    cdp: { send: vi.fn().mockResolvedValue(undefined) },
  };
}

// Drives the tool on a virtual clock that both the dispatch round-trip and
// every `sleep` advance, so a measured press→release span is exact instead of
// carrying real-scheduler jitter.
async function runOnVirtualClock(
  params: Record<string, unknown>,
  opts: { dispatchCostMs?: number; startMs?: number } = {}
) {
  const api = fakeChromiumApi();
  const dispatchCostMs = opts.dispatchCostMs ?? 0;
  let now = opts.startMs ?? 1000;
  const stamps: { type: string; at: number; x: number }[] = [];
  const sleepDelays: number[] = [];
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  api.dispatchMouseEvent.mockImplementation(async (event: Record<string, unknown>) => {
    stamps.push({ type: event.type as string, at: now, x: event.x as number });
    now += dispatchCostMs;
  });
  const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number
  ) => {
    sleepDelays.push(ms ?? 0);
    now += ms ?? 0;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as never);
  try {
    await gestureDragTool.execute({ chromium: api } as never, params as never);
  } finally {
    timeoutSpy.mockRestore();
    nowSpy.mockRestore();
  }
  return { stamps, sleepDelays };
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

  it("paces each frame off a deadline so the dispatch round-trip counts toward the 16ms budget", async () => {
    // Simulate an ~11ms CDP round-trip per dispatch and capture the delay every
    // `sleep` requests. A fixed sleep(16) would charge 16ms on top of each
    // dispatch; the deadline charges only the remainder. durationMs 320 → 20
    // steps → a 16ms frame.
    const dispatchCostMs = 11;
    const { sleepDelays } = await runOnVirtualClock(
      {
        udid: "chromium-cdp-19222",
        fromX: 0.1,
        fromY: 0.5,
        toX: 0.9,
        toY: 0.5,
        durationMs: 320,
      },
      { dispatchCostMs }
    );
    // Every frame subtracts the dispatch it just awaited from the 16ms budget.
    expect(sleepDelays.length).toBeGreaterThan(0);
    for (const delay of sleepDelays) {
      expect(delay).toBe(16 - dispatchCostMs);
    }
  });

  it("delivers the whole requested press→release span, not one frame short", async () => {
    // Pacing `steps - 1` frames off a fixed 16ms landed the release a frame
    // early - 32ms of a requested 50 - where apps threshold a flick against a
    // drag. The run-start deadline spends that last frame before the release.
    for (const durationMs of [50, 100, 300, 1000]) {
      const { stamps } = await runOnVirtualClock({
        udid: "chromium-cdp-19222",
        fromX: 0.1,
        fromY: 0.5,
        toX: 0.9,
        toY: 0.5,
        durationMs,
      });
      const press = stamps[0];
      const release = stamps[stamps.length - 1];
      expect(press.type).toBe("mousePressed");
      expect(release.type).toBe("mouseReleased");
      // Nothing costs wall clock under the mock, so the span is the pacing alone.
      expect(release.at - press.at).toBeGreaterThanOrEqual(durationMs - 3);
      expect(release.at - press.at).toBeLessThanOrEqual(durationMs + 3);
      // The release alone carries the endpoint: a move there plus the final
      // still frame would read as a hold and kill a momentum drag's fling.
      const moves = stamps.slice(1, -1);
      expect(moves.length).toBeGreaterThan(0);
      for (const move of moves) {
        expect(move.type).toBe("mouseMoved");
        expect(move.x).toBeLessThan(release.x);
      }
    }
  });

  it("momentum: false eases the moves out (release at ~0 pointer velocity); with momentum they stay linear, by default and by name", async () => {
    // Web drag libraries compute their fling from this mouse stream's release
    // velocity, so the eased curve must genuinely decay into the release.
    // durationMs 64 samples 4 frames, under the ease-out floor, so the eased path
    // runs on the floor's 8-frame grid while the plain one keeps 4.
    const params = { udid: "chromium-cdp-19222", fromX: 0.25, fromY: 0.5, toX: 0.75, toY: 0.5 };
    const startPx = 0.25 * 800;
    const deltaPx = (0.75 - 0.25) * 800;

    const eased = fakeChromiumApi();
    await gestureDragTool.execute(
      { chromium: eased } as never,
      { ...params, durationMs: 64, momentum: false } as never
    );
    const easedCalls = eased.dispatchMouseEvent.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    // Endpoints are untouched by the easing — only the path between changes.
    expect(easedCalls[0]).toMatchObject({ type: "mousePressed", x: startPx });
    expect(easedCalls[easedCalls.length - 1]).toMatchObject({
      type: "mouseReleased",
      x: 0.75 * 800,
    });
    const easedMoves = easedCalls.slice(1, -1);
    // 1-(1-t)^3 at t = i/8 — each point past its linear counterpart.
    const easedProgress = [
      0.330078125, 0.578125, 0.755859375, 0.875, 0.947265625, 0.984375, 0.998046875,
    ];
    expect(easedMoves).toHaveLength(easedProgress.length);
    easedMoves.forEach((move, i) => {
      expect(move.x as number).toBeCloseTo(startPx + deltaPx * easedProgress[i], 5);
    });
    // Per-frame step size shrinks monotonically all the way into the release.
    const xs = easedCalls.map((c) => c.x as number);
    for (let i = 2; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeLessThan(xs[i - 1] - xs[i - 2]);
    }

    // The control for the ease-out above, run both ways so the flag's polarity is
    // pinned from both sides: a predicate reading any stated `momentum` as
    // momentum-free stays green on the default leg alone.
    for (const momentum of [undefined, true]) {
      const control = fakeChromiumApi();
      await gestureDragTool.execute(
        { chromium: control } as never,
        { ...params, durationMs: 64, momentum } as never
      );
      const controlMoves = control.dispatchMouseEvent.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .slice(1, -1);
      // Frame-rate sampling only - the 8-frame ease-out floor stays off it.
      expect(controlMoves).toHaveLength(3);
      // Without the ease-out the same endpoints interpolate on the straight linear grid.
      expect(controlMoves[0].x as number).toBeCloseTo(startPx + deltaPx * 0.25, 5);
      expect(controlMoves[1].x as number).toBeCloseTo(startPx + deltaPx * 0.5, 5);
      expect(controlMoves[2].x as number).toBeCloseTo(startPx + deltaPx * 0.75, 5);
    }
  });

  it("floors the ease-out sample count so the final frame before the release is a sliver of the travel", async () => {
    // The last frame of the cubic covers (1/steps)^3 of the travel. At the 2
    // samples durationMs/16 gives a 32ms drag that is 12.5%, crossed in the frame
    // the page reads as release velocity - `momentum: false` measured as a no-op
    // there. The floor drops it to ~0.2%.
    const params = { udid: "chromium-cdp-19222", fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 };
    const finalFrameFraction = (stamps: { x: number }[]) => {
      const last = stamps[stamps.length - 1];
      return (last.x - stamps[stamps.length - 2].x) / (last.x - stamps[0].x);
    };
    for (const durationMs of [32, 50, 100]) {
      const eased = await runOnVirtualClock({ ...params, durationMs, momentum: false });
      expect(eased.stamps.slice(1, -1)).toHaveLength(7);
      expect(finalFrameFraction(eased.stamps)).toBeLessThan(0.005);
      // Same duration with momentum: sampling untouched, its final frame still
      // carrying a sixth to a half of the travel. Named `true` has to land on the
      // same grid as the default, or the floor reaches a drag that asked for
      // momentum out loud.
      for (const momentum of [undefined, true]) {
        const plain = await runOnVirtualClock({ ...params, durationMs, momentum });
        expect(plain.stamps.slice(1, -1)).toHaveLength(
          Math.max(2, Math.round(durationMs / 16)) - 1
        );
        expect(finalFrameFraction(plain.stamps)).toBeGreaterThan(0.15);
      }
    }
  });

  it("keeps the ease-out floor off the press→release span and off an already well-sampled drag", async () => {
    const params = { udid: "chromium-cdp-19222", fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 };
    const span = (stamps: { at: number }[]) => stamps[stamps.length - 1].at - stamps[0].at;
    // 300ms samples 19 frames on its own, above the floor: `momentum: false`
    // bends the curve and nothing else — same frame count, same span.
    const longEased = await runOnVirtualClock({ ...params, durationMs: 300, momentum: false });
    const longPlain = await runOnVirtualClock({ ...params, durationMs: 300 });
    expect(longEased.stamps).toHaveLength(longPlain.stamps.length);
    expect(longEased.stamps.slice(1, -1)).toHaveLength(Math.round(300 / 16) - 1);
    expect(span(longEased.stamps)).toBeCloseTo(300, 6);
    expect(span(longPlain.stamps)).toBeCloseTo(300, 6);
    // And where the floored frame (100/8 = 12.5ms) still clears an ~9ms CDP
    // round-trip, the run-start deadline absorbs the extra samples for free —
    // apps threshold a flick against a drag on exactly this span.
    for (const durationMs of [100, 300]) {
      const eased = await runOnVirtualClock(
        { ...params, durationMs, momentum: false },
        { dispatchCostMs: 9 }
      );
      expect(span(eased.stamps)).toBeCloseTo(durationMs, 6);
    }
    // Below that, eight frames no longer fit at one round-trip each and the span
    // stretches to what the transport can deliver - the accepted cost of an
    // ease-out that isn't a no-op, and only a direct tool call reaches here.
    const overrun = await runOnVirtualClock(
      { ...params, durationMs: 32, momentum: false },
      { dispatchCostMs: 9 }
    );
    expect(span(overrun.stamps)).toBeCloseTo(8 * 9, 6);
  });

  it("clamps a normalized 1.0 endpoint to the last addressable pixel so the release stays in the viewport", async () => {
    // The flow swipe directive saturates `by` deltas to [0, 1], so a 1.0 endpoint
    // is routine - unclamped it maps one past the viewport, where a release was
    // observed reaching the page without its pointerup.
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

// A drag holds the left button down for the whole durationMs, so a cancelled run
// that never consults the signal keeps driving the page - and worse than a swipe
// does, because a press left down captures every later click.
describe("gesture-drag abort", () => {
  // 300 steps if it ever ran to completion; frameMs stays ~16.
  const long = {
    udid: "chromium-cdp-19222",
    fromX: 0.25,
    fromY: 0.5,
    toX: 0.75,
    toY: 0.5,
    durationMs: 4800,
  };

  it("releases the button where the pointer is and rejects when aborted mid-drag", async () => {
    const api = fakeChromiumApi();
    const controller = new AbortController();
    // Abort synchronously from inside the dispatch after the press and 2 moves -
    // deterministic, no real-time races.
    let dispatched = 0;
    api.dispatchMouseEvent.mockImplementation(async () => {
      if (++dispatched === 3) controller.abort();
    });

    // Pin the identity too, not just the wording: it is what separates a
    // cancel from the transport error the release can raise instead.
    await expect(
      gestureDragTool.execute(
        { chromium: api } as never,
        long as never,
        {
          signal: controller.signal,
        } as never
      )
    ).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(
        /gesture-drag aborted - cancelled mid-drag after 3 of 301 frames/
      ),
    });

    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.map((c) => c.type)).toEqual([
      "mousePressed",
      "mouseMoved",
      "mouseMoved",
      "mouseReleased",
    ]);
    // The release lands on the last dispatched move, not the authored end point:
    // jumping to the end would deliver the drag the caller cancelled.
    expect(calls[3]).toMatchObject({ x: calls[2]!.x, y: calls[2]!.y });
    expect(calls[3]!.x as number).toBeLessThan(0.75 * 800 - 1);
  });

  it("still rejects with the AbortError when the release dispatch fails, carrying it as the cause", async () => {
    // A cancel is when the CDP session can be going away, so the best-effort
    // release can reject - and the transport error must not replace the
    // AbortError, or the rejection stops saying the run was cancelled.
    const api = fakeChromiumApi();
    const controller = new AbortController();
    const releaseFailure = new Error("CDP session closed while releasing");
    let dispatched = 0;
    api.dispatchMouseEvent.mockImplementation(async (event: Record<string, unknown>) => {
      if (++dispatched === 3) controller.abort();
      if (event.type === "mouseReleased") throw releaseFailure;
    });

    const rejection = await gestureDragTool
      .execute(
        { chromium: api } as never,
        long as never,
        {
          signal: controller.signal,
        } as never
      )
      .catch((err: unknown) => err);

    expect(rejection).toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(
        /gesture-drag aborted - cancelled mid-drag after 3 of 301 frames/
      ),
    });
    // The transport failure is not lost: it stays reachable for the agent-facing
    // formatter's cause-chain walk.
    expect((rejection as Error).cause).toBe(releaseFailure);
    // The release was still attempted, at the last dispatched pointer position.
    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.map((c) => c.type)).toEqual([
      "mousePressed",
      "mouseMoved",
      "mouseMoved",
      "mouseReleased",
    ]);
    expect(calls[3]).toMatchObject({ x: calls[2]!.x, y: calls[2]!.y });
  });

  it("releases where the pointer is when the abort lands on the final frame", async () => {
    // The move loop stops one short of the release, so this frame sits OUTSIDE
    // it: unchecked, a drag cancelled here released at the authored end point and
    // returned { dragged: true } on an aborted signal. gesture-swipe covers the
    // same frame from inside its `i <= steps` loop.
    const api = fakeChromiumApi();
    const controller = new AbortController();
    // 3 steps at durationMs 48, so dispatch 3 is the last interpolated move and
    // the next frame is the release.
    let dispatched = 0;
    api.dispatchMouseEvent.mockImplementation(async () => {
      if (++dispatched === 3) controller.abort();
    });

    await expect(
      gestureDragTool.execute(
        { chromium: api } as never,
        { ...long, durationMs: 48 } as never,
        {
          signal: controller.signal,
        } as never
      )
    ).rejects.toThrow(/gesture-drag aborted - cancelled mid-drag after 3 of 4 frames/);

    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.map((c) => c.type)).toEqual([
      "mousePressed",
      "mouseMoved",
      "mouseMoved",
      "mouseReleased",
    ]);
    expect(calls[3]).toMatchObject({ x: calls[2]!.x, y: calls[2]!.y });
    expect(calls[3]!.x as number).toBeLessThan(0.75 * 800 - 1);
  });

  it("releases where the pointer is when the abort lands inside the final frame's wait", async () => {
    // The wait before the release is the one window the check above it cannot
    // see. Every move has gone out by then and the release is the dispatch under
    // test, so the only deterministic hook left is the `sleep` itself - a
    // setTimeout spy that fires the abort inside the last one.
    const api = fakeChromiumApi();
    const controller = new AbortController();
    // 3 steps at durationMs 48: two in-loop waits, then the one before the
    // release. Calling `fn` straight through keeps the run off the real clock.
    let sleeps = 0;
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      if (++sleeps === 3) controller.abort();
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never);

    let rejection: unknown;
    try {
      rejection = await gestureDragTool
        .execute(
          { chromium: api } as never,
          { ...long, durationMs: 48 } as never,
          {
            signal: controller.signal,
          } as never
        )
        .catch((err: unknown) => err);
    } finally {
      timeoutSpy.mockRestore();
    }

    // A rejection, not { dragged: true }: a raw `tool: gesture-drag` step only
    // reads as cancelled if the tool throws.
    expect(rejection).toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(
        /gesture-drag aborted - cancelled mid-drag after 3 of 4 frames/
      ),
    });

    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.map((c) => c.type)).toEqual([
      "mousePressed",
      "mouseMoved",
      "mouseMoved",
      "mouseReleased",
    ]);
    // The release stays on the last dispatched move; the travel to the end point
    // is the part the caller cancelled.
    expect(calls[3]).toMatchObject({ x: calls[2]!.x, y: calls[2]!.y });
    expect(calls[3]!.x as number).toBeLessThan(0.75 * 800 - 1);
  });

  it("presses nothing when the signal is already aborted", async () => {
    const api = fakeChromiumApi();
    const controller = new AbortController();
    controller.abort();

    await expect(
      gestureDragTool.execute(
        { chromium: api } as never,
        long as never,
        {
          signal: controller.signal,
        } as never
      )
    ).rejects.toThrow(/gesture-drag aborted - cancelled mid-drag after 0 of 301 frames/);
    expect(api.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it("runs to completion on a signal that never aborts", async () => {
    const api = fakeChromiumApi();
    const controller = new AbortController();

    const result = await gestureDragTool.execute(
      { chromium: api } as never,
      { ...long, durationMs: 64 } as never,
      { signal: controller.signal } as never
    );

    expect(result.dragged).toBe(true);
    const calls = api.dispatchMouseEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls[0]!.type).toBe("mousePressed");
    expect(calls[calls.length - 1]).toMatchObject({ type: "mouseReleased", x: 0.75 * 800 });
  });
});

// The same ceiling gesture-swipe carries, for the same reason: durationMs is
// wall clock spent mid-press, and the abort check above only rescues a caller
// who cancels. A caller that passes a huge value and waits gets all of it.
describe("gesture-drag duration ceiling", () => {
  const params = {
    udid: "chromium-cdp-19222",
    fromX: 0.25,
    fromY: 0.5,
    toX: 0.75,
    toY: 0.5,
  };

  it.each([10_001, 20_000, 1e21])("rejects durationMs %p", (durationMs) => {
    const result = gestureDragTool.zodSchema!.safeParse({ ...params, durationMs });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({
      path: ["durationMs"],
      message: expect.stringContaining("durationMs must be at most 10000"),
    });
  });

  it("rejects a non-finite durationMs, which no ordering of the bound catches", () => {
    // Math.round(Infinity / 16) is Infinity, so the frame loop never ends, and
    // frameMs would be NaN.
    for (const durationMs of [Infinity, -Infinity, NaN]) {
      expect(gestureDragTool.zodSchema!.safeParse({ ...params, durationMs }).success).toBe(false);
    }
  });

  it("accepts the exact ceiling and the default", () => {
    for (const durationMs of [10_000, 600, 300, 64]) {
      expect(gestureDragTool.zodSchema!.safeParse({ ...params, durationMs }).success).toBe(true);
    }
    expect(gestureDragTool.zodSchema!.safeParse(params).success).toBe(true);
  });
});

// `settle` was this flag's earlier spelling with the opposite polarity, and every
// dispatch path forwards only `safeParse(...).data` - left undeclared, the
// non-strict object would strip a recording's `settle: true` and run the flinging
// default, green and silent.
describe("gesture-drag retired `settle` param", () => {
  const schema = gestureDragTool.zodSchema!;
  const base = { udid: "chromium-cdp-19222", fromX: 0.25, fromY: 0.5, toX: 0.75, toY: 0.5 };

  it("rejects `settle: true` instead of stripping it, and names the replacement", () => {
    const parsed = schema.safeParse({ ...base, settle: true });

    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues[0];
    expect(issue.path).toEqual(["settle"]);
    // The error is the only place the new spelling and the flipped sense appear.
    expect(issue.message).toContain("momentum: false");
  });

  it("rejects `settle: false` too - it was the stack-build default, not a no-op to wave through", () => {
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
