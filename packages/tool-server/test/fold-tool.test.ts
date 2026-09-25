import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";

const ensureActiveScreenMock = vi.fn();
const awaitActiveScreenSettledMock = vi.fn();
vi.mock("../src/utils/foldable", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/foldable")>("../src/utils/foldable");
  return {
    ...actual,
    ensureActiveScreen: (udid: string) => ensureActiveScreenMock(udid),
    awaitActiveScreenSettled: (udid: string, previous: number | undefined) =>
      awaitActiveScreenSettledMock(udid, previous),
  };
});

import { foldTool } from "../src/tools/fold";

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

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

function answerHinge(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(body === null ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  ensureActiveScreenMock
    .mockReset()
    .mockResolvedValue({ activeScreen: 1, panels: PANELS, readAt: 0 });
  awaitActiveScreenSettledMock
    .mockReset()
    .mockResolvedValue({ activeScreen: 3, panels: PANELS, readAt: 1 });
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
  it("posts the hinge request, waits for the hand-over and names the panel", async () => {
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "open", from: "closed" }
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:61830/api/hinge");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      posture: "open",
      from: "closed",
    });
    // Settled against the panel the device was on BEFORE the sweep.
    expect(awaitActiveScreenSettledMock).toHaveBeenCalledWith(DUO, 1);
    expect(result).toEqual({
      activeScreen: 3,
      screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 },
      posture: "open",
      hingeAngle: 180,
    });
  });

  it("classifies an angle into a posture", async () => {
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 120 });
    const result = await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, angle: 120 });
    expect(result.posture).toBe("half-open");
    expect(result.hingeAngle).toBe(120);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      angle: 120,
    });
  });

  it("surfaces the server's own reason on a device that is not foldable", async () => {
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
    // Nothing to settle against on a device with one panel.
    expect(ensureActiveScreenMock).not.toHaveBeenCalled();
    expect(awaitActiveScreenSettledMock).not.toHaveBeenCalled();
  });

  it("names the missing route on a simulator-server build that predates the hinge", async () => {
    answerHinge(null, 404);
    let caught: unknown;
    try {
      await foldTool.execute!({ simulatorServer: api() }, { udid: DUO, posture: "closed" });
    } catch (err) {
      caught = err;
    }
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.IOS_FOLD_UNSUPPORTED);
    expect((caught as Error).message).toContain("no hinge endpoint");
  });

  it("warns, and keeps the last panel, when CoreDevice never answers after the sweep", async () => {
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 0 });
    awaitActiveScreenSettledMock.mockResolvedValue(null);
    ensureActiveScreenMock.mockResolvedValue({ activeScreen: 3, panels: PANELS, readAt: 0 });
    const result = await foldTool.execute!(
      { simulatorServer: api() },
      { udid: DUO, posture: "closed" }
    );
    expect(result.activeScreen).toBe(3);
    expect(result.posture).toBe("closed");
    expect(result.warning).toContain("did not report which panel");
  });

  it("gives a server that answered the hinge its panels, if the factory probe had not", async () => {
    answerHinge({ foldable: true, panels: PANELS, hingeAngle: 180 });
    const late = api({ display: undefined });
    await foldTool.execute!({ simulatorServer: late }, { udid: DUO, posture: "open" });
    expect(late.display?.foldable).toBe(true);
  });
});
