import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import type { ActiveScreenState } from "../src/utils/foldable";

const refreshActiveScreenMock = vi.fn();
const awaitActiveScreenMock = vi.fn();
const holdActiveScreenMock = vi.fn();
const activeScreenOrMainMock = vi.fn((_udid: string) => 1);
vi.mock("../src/utils/foldable", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/foldable")>("../src/utils/foldable");
  return {
    ...actual,
    refreshActiveScreen: (udid: string) => refreshActiveScreenMock(udid),
    activeScreenOrMain: (udid: string) => activeScreenOrMainMock(udid),
    awaitActiveScreen: (
      udid: string,
      done: (state: ActiveScreenState) => boolean,
      opts?: { timeoutMs?: number }
    ) => awaitActiveScreenMock(udid, done, opts),
    holdActiveScreen: (
      udid: string,
      initial: ActiveScreenState | null,
      holdMs: number,
      opts?: { signal?: AbortSignal }
    ) => holdActiveScreenMock(udid, initial, holdMs, opts),
  };
});

import { foldTool } from "../src/tools/fold";
import {
  HAND_OVER_TIMEOUT_MS,
  INPUT_READY_HOLD_MID_ANGLE_MS,
  INPUT_READY_HOLD_MS,
  SETTLE_TIMEOUT_MS,
} from "../src/utils/foldable";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const PANELS = [
  { screenId: 1, width: 1398, height: 2034 },
  { screenId: 3, width: 2007, height: 2853 },
];

function api(overrides: Partial<SimulatorServerApi> = {}): SimulatorServerApi {
  return {
    apiUrl: "http://127.0.0.1:61830",
    streamUrl: "http://127.0.0.1:61830/stream.mjpeg",
    deviceId: DUO,
    display: { foldable: true, panels: PANELS, hingeAngle: null },
    pressKey: async () => {},
    ...overrides,
  };
}

function live(activeScreen: number): ActiveScreenState {
  return { activeScreen, panels: PANELS, readAt: 0 };
}

/** The server's answers, in the order the tool asks: `GET /api/display`, then `POST /api/hinge`. */
const answers: Array<{ path: string; body: unknown; status: number }> = [];
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const next = answers.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  expect(url).toBe(`http://127.0.0.1:61830${next.path}`);
  return new Response(next.body === null ? "" : JSON.stringify(next.body), {
    status: next.status,
    headers: { "Content-Type": "application/json" },
  });
});
const realFetch = globalThis.fetch;

function answerDisplay(hingeAngle: number | null, status = 200): void {
  answers.push({
    path: "/api/display",
    body: status === 200 ? { foldable: true, panels: PANELS, hingeAngle } : null,
    status,
  });
}

function answerHinge(body: unknown, status = 200): void {
  answers.push({ path: "/api/hinge", body, status });
}

function hingeBody(): unknown {
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/api/hinge"));
  return JSON.parse((call![1] as RequestInit).body as string);
}

/** The predicate the tool waited on, and the budget it gave it. */
function awaited(): { done: (s: ActiveScreenState) => boolean; timeoutMs?: number } {
  const [, done, opts] = awaitActiveScreenMock.mock.calls[0]! as [
    string,
    (s: ActiveScreenState) => boolean,
    { timeoutMs?: number } | undefined,
  ];
  return { done, timeoutMs: opts?.timeoutMs };
}

/** The panel the tool waited for: the first screen id its predicate accepts. */
function awaitedPanel(): number | undefined {
  return [1, 3].find((id) => awaited().done(live(id)));
}

/** How long the tool held for input after the settle. */
function heldMs(): number {
  return holdActiveScreenMock.mock.calls[0]![2] as number;
}

beforeEach(() => {
  answers.length = 0;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  refreshActiveScreenMock.mockReset().mockResolvedValue(live(1));
  activeScreenOrMainMock.mockReset().mockReturnValue(1);
  // Answers with the first state the predicate accepts, like a hand-over that landed.
  awaitActiveScreenMock
    .mockReset()
    .mockImplementation(
      async (_udid: string, done: (s: ActiveScreenState) => boolean) =>
        [live(1), live(3)].find(done) ?? live(1)
    );
  // A hold during which the panel stayed put answers what it was given.
  holdActiveScreenMock
    .mockReset()
    .mockImplementation(async (_udid: string, initial: ActiveScreenState | null) => initial);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fold tool — input", () => {
  it("takes exactly one of posture and angle", () => {
    expect(foldTool.zodSchema!.safeParse({ udid: DUO, posture: "open" }).success).toBe(true);
    expect(foldTool.zodSchema!.safeParse({ udid: DUO, angle: 120 }).success).toBe(true);
    expect(foldTool.zodSchema!.safeParse({ udid: DUO }).success).toBe(false);
    expect(foldTool.zodSchema!.safeParse({ udid: DUO, posture: "open", angle: 180 }).success).toBe(
      false
    );
    expect(foldTool.zodSchema!.safeParse({ udid: DUO, angle: 181 }).success).toBe(false);
    expect(
      foldTool.zodSchema!.safeParse({ udid: DUO, posture: "open", from: "closed" }).success
    ).toBe(true);
    expect(foldTool.zodSchema!.safeParse({ udid: DUO, angle: 60, from: 0 }).success).toBe(true);
  });

  it("is a local-simulator tool only", () => {
    expect(foldTool.capability).toEqual({ apple: { simulator: true } });
  });
});

describe("fold tool — execute", () => {
  it("reads both ends fresh, posts the hinge, waits for the implied panel and holds for input", async () => {
    answerDisplay(0);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );

    // The live panel is read, never taken from the memo.
    expect(refreshActiveScreenMock).toHaveBeenCalledWith(DUO);
    // The server's start (closed) is on the panel the device renders to, so it is kept.
    expect(hingeBody()).toEqual({ posture: "open" });
    // Open implies the inner panel; the wait is for that panel, with the hand-over budget.
    expect(awaitedPanel()).toBe(3);
    expect(awaited().timeoutMs).toBe(HAND_OVER_TIMEOUT_MS);
    // The sweep ends at a stop (open), so the shorter input-ready hold precedes
    // the answer, from the state the wait settled on.
    expect(heldMs()).toBe(INPUT_READY_HOLD_MS);
    expect(holdActiveScreenMock.mock.calls[0]![1]).toEqual(live(3));
    expect(result).toEqual({
      activeScreen: 3,
      screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 },
      posture: "open",
      hingeAngle: 180,
    });
  });

  it("starts the sweep on the device's panel when the server never moved the hinge of a device left open", async () => {
    // A fresh server assumes closed; the device is open. Sweeping 0 -> 180
    // would cross the hand-over and flip the panel twice.
    answerDisplay(null);
    refreshActiveScreenMock.mockResolvedValue(live(3));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );
    expect(hingeBody()).toEqual({ posture: "open", from: "open" });
    expect(result.activeScreen).toBe(3);
    // The hinge moved, so the guest still gets its hold, panel change or not.
    expect(heldMs()).toBe(INPUT_READY_HOLD_MS);
  });

  it("starts the sweep on the device's panel after a fold made outside argent", async () => {
    // argent last opened the device (server at 180); Device Hub closed it since.
    answerDisplay(180);
    refreshActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    expect(hingeBody()).toEqual({ posture: "closed", from: "closed" });
    expect(awaitedPanel()).toBe(1);
    expect(result.activeScreen).toBe(1);
  });

  it("keeps the start the caller named", async () => {
    answerDisplay(null);
    refreshActiveScreenMock.mockResolvedValue(live(3));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed", from: "half-open" }
    );
    expect(hingeBody()).toEqual({ posture: "closed", from: "half-open" });
  });

  it("classifies an angle into a posture and waits for the panel the angle implies", async () => {
    answerDisplay(0);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 120 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 120 });
    expect(result.posture).toBe("half-open");
    expect(result.hingeAngle).toBe(120);
    expect(hingeBody()).toEqual({ angle: 120 });
    expect(awaitedPanel()).toBe(3);
    // The hinge stops short of open: the guest ignores input for longer.
    expect(heldMs()).toBe(INPUT_READY_HOLD_MID_ANGLE_MS);
  });

  it("holds the longer time for half-open, and for an angle that stays on the cover panel", async () => {
    answerDisplay(0);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 120 });
    await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, posture: "half-open" });
    expect(heldMs()).toBe(INPUT_READY_HOLD_MID_ANGLE_MS);

    holdActiveScreenMock.mockClear();
    answerDisplay(0);
    refreshActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 30 });
    await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 30 });
    expect(heldMs()).toBe(INPUT_READY_HOLD_MID_ANGLE_MS);
  });

  it("waits for any change, with the shorter budget, at an angle near the hand-over", async () => {
    answerDisplay(0);
    awaitActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 80 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 80 });
    const { done, timeoutMs } = awaited();
    expect(done(live(1))).toBe(false);
    expect(done(live(3))).toBe(true);
    expect(timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    // Staying put is an answer there, not a failure.
    expect(result.activeScreen).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("predicts nothing for a sweep that starts between the stops, and reports where the device stayed", async () => {
    // The server holds the hinge at 75°, on the cover panel. 75° -> 90° is a
    // short sweep the guest does not hand over on: the tool waits for any
    // change, sees none, and answers the panel the device kept — no failure,
    // no warning, since nothing was predicted.
    answerDisplay(75);
    refreshActiveScreenMock.mockResolvedValue(live(1));
    awaitActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 90 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 90 });
    expect(hingeBody()).toEqual({ angle: 90 });
    const { done, timeoutMs } = awaited();
    expect(done(live(1))).toBe(false);
    expect(done(live(3))).toBe(true);
    expect(timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    expect(result.activeScreen).toBe(1);
    expect(result.posture).toBe("half-open");
    expect(result.warning).toBeUndefined();

    // The same the other way: 120° -> 75° from the inner panel stays inner.
    awaitActiveScreenMock.mockClear();
    answerDisplay(120);
    refreshActiveScreenMock.mockResolvedValue(live(3));
    awaitActiveScreenMock.mockResolvedValue(live(3));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 75 });
    const back = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 75 });
    expect(awaited().timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    expect(back.activeScreen).toBe(3);
    expect(back.warning).toBeUndefined();
  });

  it("predicts the panel from a caller-named start at a stop, and not from one between", async () => {
    answerDisplay(null);
    refreshActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 120 });
    await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 120, from: 0 });
    expect(awaitedPanel()).toBe(3);
    expect(awaited().timeoutMs).toBe(HAND_OVER_TIMEOUT_MS);

    awaitActiveScreenMock.mockClear();
    answerDisplay(null);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 120 });
    await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 120, from: 100 });
    expect(awaited().timeoutMs).toBe(SETTLE_TIMEOUT_MS);
  });

  it("warns, rather than fails, when the device kept a panel other than the one the sweep implied", async () => {
    answerDisplay(0);
    awaitActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );
    expect(result.activeScreen).toBe(1);
    expect(result.screen).toEqual({ id: 1, panel: "cover panel", width: 1398, height: 2034 });
    expect(result.warning).toContain("kept rendering to screen 1 (cover panel, 1398x2034)");
    expect(result.warning).toContain("switching to screen 3 (inner panel, 2007x2853)");
    expect(result.warning).toContain("fold to closed or open first");
    // The guest still moved its hinge, so it still gets the hold.
    expect(holdActiveScreenMock).toHaveBeenCalledTimes(1);
  });

  it("answers the panel the hold ended on, not the one the wait first saw", async () => {
    // From closed to 78°: CoreDevice reports the inner panel for about a
    // second, then the cover again. The wait latches the first change; the
    // hold, still watching, ends on the cover — and that is what is answered
    // and what the memo holds.
    answerDisplay(0);
    awaitActiveScreenMock.mockResolvedValue(live(3));
    holdActiveScreenMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 78 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 78 });
    expect(holdActiveScreenMock.mock.calls[0]![1]).toEqual(live(3));
    expect(result.activeScreen).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("surfaces the server's own reason on a device that is not foldable", async () => {
    answers.push({
      path: "/api/display",
      body: {
        foldable: false,
        panels: [{ screenId: 1, width: 1206, height: 2622 }],
        hingeAngle: null,
      },
      status: 200,
    });
    answerHinge({ error: "the hinge can only be moved on a foldable iOS simulator" });
    const flat = api({ deviceId: "AAAAAAAA-0000-0000-0000-000000000000", display: undefined });
    await expect(
      foldTool.execute!(
        { simulatorServer: flat },
        { udid: "AAAAAAAA-0000-0000-0000-000000000000", posture: "open" }
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining("the hinge can only be moved on a foldable iOS simulator"),
    });
    // Nothing to read or settle against on a device with one panel.
    expect(refreshActiveScreenMock).not.toHaveBeenCalled();
    expect(awaitActiveScreenMock).not.toHaveBeenCalled();
    expect(flat.display).toBeUndefined();
  });

  it("names the missing route on a simulator-server build that predates the hinge", async () => {
    answerDisplay(null, 404);
    answerHinge(null, 404);
    let caught: unknown;
    try {
      await foldTool.execute!(
        { simulatorServer: api({ display: undefined }) },
        { udid: DUO, posture: "closed" }
      );
    } catch (err) {
      caught = err;
    }
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.IOS_FOLD_UNSUPPORTED);
    expect((caught as Error).message).toContain("no hinge endpoint");
  });

  it("warns, and keeps the panel the tools target, when CoreDevice never answers", async () => {
    // Every read fails, before and after the sweep; the memo still holds the
    // inner panel from an earlier read, and that is what every touch and
    // screenshot targets — so that is what the fold reports too.
    answerDisplay(180);
    refreshActiveScreenMock.mockResolvedValue(null);
    awaitActiveScreenMock.mockResolvedValue(null);
    holdActiveScreenMock.mockResolvedValue(null);
    activeScreenOrMainMock.mockReturnValue(3);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    // With no live panel there is nothing to start the sweep from but the server's angle.
    expect(hingeBody()).toEqual({ posture: "closed" });
    expect(result.activeScreen).toBe(3);
    expect(result.screen).toEqual({ id: 3, panel: "inner panel", width: 2007, height: 2853 });
    expect(result.posture).toBe("closed");
    expect(result.warning).toContain("did not report which panel");
    expect(result.warning).toContain("commands target screen 3 (inner panel, 2007x2853)");
  });

  it("gives a server that answered the hinge its panels and the angle it now holds", async () => {
    answerDisplay(null);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const late = api({ display: undefined });
    await foldTool.execute!({ simulatorServer: late }, { udid: DUO, posture: "open" });
    expect(late.display).toEqual({ foldable: true, panels: PANELS, hingeAngle: 180 });
  });
});
