import { describe, expect, it, vi } from "vitest";
import {
  touchPaths,
  type RunnerViewport,
  type RunnerTouchFinger,
} from "../src/utils/ios-device/runner-commands";
import { pinchPaths, rotatePaths, trainPaths } from "../src/utils/ios-device/touch-paths";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { setCurrentIosDeviceApp } from "../src/utils/ios-device/app-session";
import type { IosDeviceRunnerApi } from "../src/blueprints/ios-device-runner";

const UDID = "00008110-000978540290401E";
const VIEWPORT: RunnerViewport = { x: 0, y: 0, width: 400, height: 800 };

describe("pinchPaths", () => {
  it("spreads two fingers about the centre, one frame per 16 ms, the last frame at the full duration", () => {
    const fingers = pinchPaths(
      { centerX: 0.5, centerY: 0.5, startDistance: 0.1, endDistance: 0.5 },
      VIEWPORT,
      32
    );

    expect(roundPoints(fingers)).toEqual([
      {
        points: [
          { x: 180, y: 400, tMs: 0 },
          { x: 140, y: 400, tMs: 16 },
          { x: 100, y: 400, tMs: 32 },
        ],
      },
      {
        points: [
          { x: 220, y: 400, tMs: 0 },
          { x: 260, y: 400, tMs: 16 },
          { x: 300, y: 400, tMs: 32 },
        ],
      },
    ]);
  });

  it("scales an odd duration across whole frames without drifting past it", () => {
    const [first] = pinchPaths(
      { centerX: 0.5, centerY: 0.5, startDistance: 0.1, endDistance: 0.5 },
      VIEWPORT,
      300
    );

    // round(300 / 16) = 19 frames, so 20 points, the last exactly at 300 ms.
    expect(first.points).toHaveLength(20);
    expect(first.points[19].tMs).toBe(300);
  });

  it("follows the axis angle and the drifting centre", () => {
    const [first, second] = pinchPaths(
      {
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.2,
        endDistance: 0.2,
        angle: 90,
        endCenterX: 0.75,
      },
      VIEWPORT,
      16
    );

    // Vertical axis: fingers 0.1 of the height above and below the centre.
    expect(first.points[0]).toEqual({ x: 200, y: 320, tMs: 0 });
    expect(second.points[0]).toEqual({ x: 200, y: 480, tMs: 0 });
    expect(first.points[1]).toEqual({ x: 300, y: 320, tMs: 16 });
  });

  it("clamps a finger that would leave the screen and keeps the viewport origin", () => {
    const inset: RunnerViewport = { x: 0, y: 20, width: 400, height: 780 };
    const [first] = pinchPaths(
      { centerX: 0.1, centerY: 0.5, startDistance: 0.4, endDistance: 0.4 },
      inset,
      16
    );

    expect(first.points[0]).toEqual({ x: 0, y: 20 + 390, tMs: 0 });
  });
});

describe("rotatePaths", () => {
  it("orbits two opposite fingers a quarter turn", () => {
    const [first, second] = rotatePaths(
      {
        centerX: 0.5,
        centerY: 0.5,
        radiusX: 0.25,
        radiusY: 0.125,
        startAngle: 0,
        endAngle: 90,
      },
      VIEWPORT,
      16
    );

    expect(first.points[0].x).toBeCloseTo(300, 9);
    expect(first.points[0].y).toBeCloseTo(400, 9);
    expect(first.points[1].x).toBeCloseTo(200, 9);
    expect(first.points[1].y).toBeCloseTo(500, 9);
    expect(second.points[0].x).toBeCloseTo(100, 9);
    expect(second.points[1].y).toBeCloseTo(300, 9);
    expect(first.points.map((p) => p.tMs)).toEqual([0, 16]);
  });
});

describe("trainPaths", () => {
  it("starts the Down at 0 and spaces later events by their delay, defaulting to 16 ms", () => {
    const fingers = trainPaths(
      [
        { type: "Down", x: 0.5, y: 0.5 },
        { type: "Move", x: 0.6, y: 0.5 },
        { type: "Move", x: 0.7, y: 0.5, delayMs: 100 },
        { type: "Up", x: 0.8, y: 0.5, delayMs: 50 },
      ],
      VIEWPORT
    );

    expect(fingers).toEqual([
      {
        points: [
          { x: 200, y: 400, tMs: 0 },
          { x: 240, y: 400, tMs: 16 },
          { x: 280, y: 400, tMs: 116 },
          { x: 320, y: 400, tMs: 166 },
        ],
      },
    ]);
  });

  it("ignores the delay on the Down: nothing is touching yet", () => {
    const [finger] = trainPaths(
      [
        { type: "Down", x: 0.5, y: 0.5, delayMs: 900 },
        { type: "Up", x: 0.5, y: 0.6, delayMs: 20 },
      ],
      VIEWPORT
    );

    expect(finger.points.map((p) => p.tMs)).toEqual([0, 20]);
  });

  it.each([
    ["no events", []],
    ["a lone Down", [{ type: "Down" as const, x: 0, y: 0 }]],
    [
      "a Move first",
      [
        { type: "Move" as const, x: 0, y: 0 },
        { type: "Up" as const, x: 0, y: 0 },
      ],
    ],
    [
      "a second Down in the middle",
      [
        { type: "Down" as const, x: 0, y: 0 },
        { type: "Down" as const, x: 0, y: 0 },
        { type: "Up" as const, x: 0, y: 0 },
      ],
    ],
  ])("refuses %s", (_name, events) => {
    expect(() => trainPaths(events, VIEWPORT)).toThrow(/^A touch train (starts|has only)/);
  });

  it("refuses an event with only one coordinate of the second finger", () => {
    expect(() =>
      trainPaths(
        [
          { type: "Down", x: 0.5, y: 0.5 },
          { type: "Up", x: 0.5, y: 0.5, y2: 0.4 },
        ],
        VIEWPORT
      )
    ).toThrow("Event 1 has only one of x2 and y2; give both or neither.");
  });
});

describe("touchPaths wire shape", () => {
  const fingers: RunnerTouchFinger[] = [
    {
      points: [
        { x: 1, y: 2, tMs: 0 },
        { x: 3, y: 4, tMs: 16 },
      ],
    },
  ];

  it("sends the fingers as one mutating command with a gesture timeout", async () => {
    const run = vi.fn().mockResolvedValue({ message: "touched" });
    const api: IosDeviceRunnerApi = { udid: UDID, run };

    const reply = await touchPaths(api, "com.example.app", fingers);

    expect(run).toHaveBeenCalledWith(
      { command: "touchPaths", appBundleId: "com.example.app", fingers },
      { timeoutMs: 90_000 }
    );
    // Read-only would let the client replay a lost reply and touch twice.
    expect(run.mock.calls[0][1]).not.toHaveProperty("readOnly");
    expect(reply).toEqual({ reactivated: false });
  });

  it("surfaces the runner re-fronting the app", async () => {
    const run = vi.fn().mockResolvedValue({ message: "touched", reactivated: true });
    const api: IosDeviceRunnerApi = { udid: UDID, run };

    expect(await touchPaths(api, "com.example.app", fingers)).toEqual({ reactivated: true });
  });
});

/** Float noise from the trigonometry and the 0-1 scaling, not a difference worth asserting. */
function roundPoints(fingers: RunnerTouchFinger[]): RunnerTouchFinger[] {
  return fingers.map((finger) => ({
    points: finger.points.map((p) => ({ ...p, x: +p.x.toFixed(6), y: +p.y.toFixed(6) })),
  }));
}

describe("gesture-pinch and gesture-rotate on a physical iPhone", () => {
  function rig(reply: Record<string, unknown> = {}) {
    setCurrentIosDeviceApp(UDID, "com.example.app");
    const run = vi.fn(async (req: Record<string, unknown>) =>
      req.command === "viewport" ? { x: 0, y: 0, width: 390, height: 844 } : reply
    );
    return { run, services: { iosDeviceRunner: { udid: UDID, run } } as never };
  }

  it("declares the runner, not the simulator server", () => {
    const params = {
      udid: UDID,
      centerX: 0.5,
      centerY: 0.5,
      startDistance: 0.1,
      endDistance: 0.5,
    };
    expect(Object.keys(gesturePinchTool.services(params))).toEqual(["iosDeviceRunner"]);
    expect(
      Object.keys(
        gestureRotateTool.services({
          udid: UDID,
          centerX: 0.5,
          centerY: 0.5,
          radius: 0.15,
          startAngle: 0,
          endAngle: 90,
        })
      )
    ).toEqual(["iosDeviceRunner"]);
  });

  it("pinches through one touchPaths command and reports the result shape", async () => {
    const { run, services } = rig();

    const result = await gesturePinchTool.execute(services, {
      udid: UDID,
      centerX: 0.5,
      centerY: 0.5,
      startDistance: 0.1,
      endDistance: 0.5,
      durationMs: 32,
    });

    const plays = run.mock.calls.filter(([req]) => req.command === "touchPaths");
    expect(plays).toHaveLength(1);
    expect(roundPoints(plays[0][0].fingers as RunnerTouchFinger[])).toEqual([
      {
        points: [
          { x: 175.5, y: 422, tMs: 0 },
          { x: 136.5, y: 422, tMs: 16 },
          { x: 97.5, y: 422, tMs: 32 },
        ],
      },
      {
        points: [
          { x: 214.5, y: 422, tMs: 0 },
          { x: 253.5, y: 422, tMs: 16 },
          { x: 292.5, y: 422, tMs: 32 },
        ],
      },
    ]);
    expect(result).toEqual({ pinched: true, timestampMs: expect.any(Number) });
  });

  it("rotates through one touchPaths command and stamps a re-front", async () => {
    const { run, services } = rig({ reactivated: true });

    const result = await gestureRotateTool.execute(services, {
      udid: UDID,
      centerX: 0.5,
      centerY: 0.5,
      radius: 0.1,
      startAngle: 0,
      endAngle: 90,
      durationMs: 16,
    });

    const plays = run.mock.calls.filter(([req]) => req.command === "touchPaths");
    expect(plays).toHaveLength(1);
    expect(plays[0][0].fingers).toHaveLength(2);
    expect(result).toEqual({ rotated: true, timestampMs: expect.any(Number), reactivated: true });
  });
});
