import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import type { LivePanel } from "../src/utils/foldable";

const resolveLivePanelMock = vi.fn();
const awaitLivePanelMock = vi.fn();
const holdLivePanelMock = vi.fn();
vi.mock("../src/utils/foldable", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/foldable")>("../src/utils/foldable");
  return {
    ...actual,
    resolveLivePanel: (udid: string) => resolveLivePanelMock(udid),
    awaitLivePanel: (
      udid: string,
      done: (screen: number) => boolean,
      opts?: { timeoutMs?: number }
    ) => awaitLivePanelMock(udid, done, opts),
    holdLivePanel: (
      udid: string,
      initial: LivePanel | null,
      holdMs: number,
      opts?: { signal?: AbortSignal }
    ) => holdLivePanelMock(udid, initial, holdMs, opts),
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

function live(screen: number): LivePanel {
  return { screen, source: "ax-service" };
}

const UNKNOWN: LivePanel = {
  screen: 1,
  source: "unknown",
  reason: "the accessibility service failed (not connected); CoreDevice failed (no)",
};

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
function awaited(): { done: (screen: number) => boolean; timeoutMs?: number } {
  const [, done, opts] = awaitLivePanelMock.mock.calls[0]! as [
    string,
    (screen: number) => boolean,
    { timeoutMs?: number } | undefined,
  ];
  return { done, timeoutMs: opts?.timeoutMs };
}

/** The panel the tool waited for: the first screen id its predicate accepts. */
function awaitedPanel(): number | undefined {
  return [1, 3].find((id) => awaited().done(id));
}

/** How long the tool held for input after the settle. */
function heldMs(): number {
  return holdLivePanelMock.mock.calls[0]![2] as number;
}

beforeEach(() => {
  answers.length = 0;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  resolveLivePanelMock.mockReset().mockResolvedValue(live(1));
  // Answers with the first panel the predicate accepts, like a hand-over that landed.
  awaitLivePanelMock
    .mockReset()
    .mockImplementation(
      async (_udid: string, done: (screen: number) => boolean) =>
        [live(1), live(3)].find((p) => done(p.screen)) ?? live(1)
    );
  // A hold during which the panel stayed put answers what it was given.
  holdLivePanelMock
    .mockReset()
    .mockImplementation(async (_udid: string, initial: LivePanel | null) => initial);
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
  });

  it("is a local-simulator tool only", () => {
    expect(foldTool.capability).toEqual({ apple: { simulator: true } });
  });
});

describe("fold tool — execute", () => {
  it("resolves both ends now, posts the hinge, waits for the implied panel and holds for input", async () => {
    answerDisplay(0);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );

    // The live panel is resolved for this fold.
    expect(resolveLivePanelMock).toHaveBeenCalledWith(DUO);
    // The server's start (closed) is on the panel the device renders to, so it is kept.
    expect(hingeBody()).toEqual({ posture: "open" });
    // Open implies the inner panel; the wait is for that panel, with the hand-over budget.
    expect(awaitedPanel()).toBe(3);
    expect(awaited().timeoutMs).toBe(HAND_OVER_TIMEOUT_MS);
    // The sweep ends at a stop (open), so the shorter input-ready hold precedes
    // the answer, from the state the wait settled on.
    expect(heldMs()).toBe(INPUT_READY_HOLD_MS);
    expect(holdLivePanelMock.mock.calls[0]![1]).toEqual(live(3));
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
    resolveLivePanelMock.mockResolvedValue(live(3));
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
    resolveLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    expect(hingeBody()).toEqual({ posture: "closed", from: "closed" });
    expect(awaitedPanel()).toBe(1);
    expect(result.activeScreen).toBe(1);
  });

  it("names the preset an angle sits at and waits for the panel the angle implies", async () => {
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

    holdLivePanelMock.mockClear();
    answerDisplay(0);
    resolveLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 30 });
    const thirty = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 30 });
    expect(heldMs()).toBe(INPUT_READY_HOLD_MID_ANGLE_MS);
    // 30° is no preset: it is not "half-open" (the docs' inner panel) while
    // the cover panel is live; the angle and the panel say where it is.
    expect(thirty).not.toHaveProperty("posture");
    expect(thirty.hingeAngle).toBe(30);
    expect(thirty.activeScreen).toBe(1);
  });

  it("waits for any change, with the shorter budget, at an angle near the hand-over", async () => {
    answerDisplay(0);
    awaitLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 80 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 80 });
    const { done, timeoutMs } = awaited();
    expect(done(1)).toBe(false);
    expect(done(3)).toBe(true);
    expect(timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    // Staying put is an answer there, not a failure.
    expect(result.activeScreen).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("predicts nothing for a sweep between two angles short of the stops, and reports where the device stayed", async () => {
    // The server holds the hinge at 75°, on the cover panel. 75° -> 90° is a
    // short sweep the guest does not hand over on: the tool waits for any
    // change, sees none, and answers the panel the device kept — no failure,
    // no warning, since nothing was predicted.
    answerDisplay(75);
    resolveLivePanelMock.mockResolvedValue(live(1));
    awaitLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 90 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 90 });
    expect(hingeBody()).toEqual({ angle: 90 });
    const { done, timeoutMs } = awaited();
    expect(done(1)).toBe(false);
    expect(done(3)).toBe(true);
    expect(timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    expect(result.activeScreen).toBe(1);
    expect(result).not.toHaveProperty("posture");
    expect(result.warning).toBeUndefined();

    // The same the other way: 120° -> 75° from the inner panel stays inner.
    awaitLivePanelMock.mockClear();
    answerDisplay(120);
    resolveLivePanelMock.mockResolvedValue(live(3));
    awaitLivePanelMock.mockResolvedValue(live(3));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 75 });
    const back = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 75 });
    expect(awaited().timeoutMs).toBe(SETTLE_TIMEOUT_MS);
    expect(back.activeScreen).toBe(3);
    expect(back.warning).toBeUndefined();
  });

  it("predicts the panel for a sweep that ends at a stop, whatever it starts from", async () => {
    // The server holds the hinge at 120°, on the inner panel. Open ends on the
    // inner panel and closed on the cover whatever the path, so both are waited
    // for with the hand-over budget — not for "any change" with the settle one,
    // which a sweep that keeps its panel would only run out.
    answerDisplay(120);
    resolveLivePanelMock.mockResolvedValue(live(3));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const opened = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );
    // 120° and the inner panel agree, so the sweep starts where the server has the hinge.
    expect(hingeBody()).toEqual({ posture: "open" });
    expect(awaitedPanel()).toBe(3);
    expect(awaited().timeoutMs).toBe(HAND_OVER_TIMEOUT_MS);
    expect(opened.activeScreen).toBe(3);
    expect(opened.warning).toBeUndefined();
    expect(heldMs()).toBe(INPUT_READY_HOLD_MS);

    awaitLivePanelMock.mockClear();
    holdLivePanelMock.mockClear();
    answerDisplay(120);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    const closed = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    expect(awaitedPanel()).toBe(1);
    expect(awaited().timeoutMs).toBe(HAND_OVER_TIMEOUT_MS);
    expect(closed.activeScreen).toBe(1);
    expect(closed.warning).toBeUndefined();
  });

  it("warns, rather than fails, when the device kept a panel other than the one the sweep implied", async () => {
    answerDisplay(0);
    awaitLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open" }
    );
    expect(result.activeScreen).toBe(1);
    expect(result.screen).toEqual({ id: 1, panel: "cover panel", width: 1398, height: 2034 });
    expect(result.warning).toContain("kept rendering to screen 1 (cover panel, 1398x2034)");
    expect(result.warning).toContain("switching to screen 3 (inner panel, 2007x2853)");
    // A stop is the target that switches panels by itself: no "fold to a stop first" advice.
    expect(result.warning).toContain("Fold again if the device did not switch");
    // The guest still moved its hinge, so it still gets the hold.
    expect(holdLivePanelMock).toHaveBeenCalledTimes(1);
  });

  it("answers the panel the hold ended on, not the one the wait first saw", async () => {
    // From closed to 78°: the device shows the inner panel for about a
    // second, then the cover again. The wait takes the first change; the
    // hold, still watching, ends on the cover — and that is what is answered.
    answerDisplay(0);
    awaitLivePanelMock.mockResolvedValue(live(3));
    holdLivePanelMock.mockResolvedValue(live(1));
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 78 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 78 });
    expect(holdLivePanelMock.mock.calls[0]![1]).toEqual(live(3));
    expect(result.activeScreen).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("surfaces the server's own reason on a device that is not foldable, as unsupported", async () => {
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
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).toContain(
        "the hinge can only be moved on a foldable iOS simulator"
      );
      // The caller's mistake, not a server failure.
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.IOS_FOLD_UNSUPPORTED,
        error_kind: "unsupported",
      });
      return true;
    });
    // Nothing to resolve or settle against on a device with one panel.
    expect(resolveLivePanelMock).not.toHaveBeenCalled();
    expect(awaitLivePanelMock).not.toHaveBeenCalled();
    expect(flat.display).toBeUndefined();
  });

  it("keeps a refusal on a foldable a fold failure", async () => {
    answerDisplay(0);
    answerHinge({ error: "the hinge did not move" });
    let caught: unknown;
    try {
      await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, posture: "open" });
    } catch (err) {
      caught = err;
    }
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.IOS_FOLD_FAILED);
    expect((caught as Error).message).toContain("the hinge did not move");
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

  it("warns, and names the main screen, when nothing resolves the panel", async () => {
    // Neither source answers, before or after the sweep: the commands fall
    // back to the main screen, and the fold says so and why.
    answerDisplay(180);
    resolveLivePanelMock.mockResolvedValue(UNKNOWN);
    awaitLivePanelMock.mockResolvedValue(null);
    holdLivePanelMock.mockResolvedValue(null);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    // With no live panel there is nothing to start the sweep from but the server's angle.
    expect(hingeBody()).toEqual({ posture: "closed" });
    expect(result.activeScreen).toBe(1);
    expect(result.screen).toEqual({ id: 1, panel: "cover panel", width: 1398, height: 2034 });
    expect(result.posture).toBe("closed");
    expect(result.warning).toContain("could not be resolved (the accessibility service failed");
    expect(result.warning).toContain("commands target screen 1 (cover panel, 1398x2034)");
    expect(result.warning).toContain("Take a screenshot to see the screen.");
  });

  it("gives a server that answered the hinge its panels and the angle it now holds", async () => {
    answerDisplay(null);
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const late = api({ display: undefined });
    await foldTool.execute!({ simulatorServer: late }, { udid: DUO, posture: "open" });
    expect(late.display).toEqual({ foldable: true, panels: PANELS, hingeAngle: 180 });
  });
});
