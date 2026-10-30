import { describe, expect, it, vi } from "vitest";

import { Registry } from "@argent/registry";
import { gestureCustomTool } from "../../src/tools/gesture-custom";
import { InvalidToolInputError } from "../../src/utils/capability";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";

// Physical-iOS UDID shape (8 hex, dash, 16 hex) routes to the runner branch.
const DEVICE_UDID = "00008110-000978540290401E";

const pressHold = [
  { type: "Down" as const, x: 0.5, y: 0.5 },
  { type: "Up" as const, x: 0.5, y: 0.5, delayMs: 800 },
];
const twoFinger = [
  { type: "Down" as const, x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
  { type: "Up" as const, x: 0.2, y: 0.5, x2: 0.8, y2: 0.5 },
];
const withWaypoints = [
  { type: "Down" as const, x: 0.5, y: 0.7 },
  { type: "Move" as const, x: 0.5, y: 0.5 },
  { type: "Up" as const, x: 0.5, y: 0.3 },
];
const dragTrain = [
  { type: "Down" as const, x: 0.5, y: 0.6 },
  { type: "Up" as const, x: 0.5, y: 0.3, delayMs: 1500 },
];
const pickupTrain = [
  { type: "Down" as const, x: 0.5, y: 0.6 },
  { type: "Move" as const, x: 0.5, y: 0.6, delayMs: 800 },
  { type: "Up" as const, x: 0.5, y: 0.3, delayMs: 500 },
];
const moveAtDestination = [
  { type: "Down" as const, x: 0.5, y: 0.6 },
  { type: "Move" as const, x: 0.5, y: 0.3, delayMs: 800 },
  { type: "Up" as const, x: 0.5, y: 0.3, delayMs: 500 },
];

function runnerRig() {
  setCurrentIosDeviceApp(DEVICE_UDID, "com.example.app");
  const run = vi.fn(async (req: Record<string, unknown>) =>
    req.command === "viewport" ? { x: 0, y: 0, width: 390, height: 844 } : {}
  );
  return { run, services: { iosDeviceRunner: { udid: DEVICE_UDID, run } } as never };
}

describe("gesture-custom on a physical iOS device", () => {
  it("maps a same-point Down/Up onto the runner's longPress", async () => {
    const { run, services } = runnerRig();
    await gestureCustomTool.execute(services, { udid: DEVICE_UDID, events: pressHold });
    const presses = run.mock.calls.filter(([req]) => req.command === "longPress");
    expect(presses).toHaveLength(1);
    expect(presses[0][0]).toMatchObject({ appBundleId: "com.example.app", durationMs: 800 });
  });

  it("maps a Down/Up drag onto the runner's drag with the Up delay as the hold", async () => {
    const { run, services } = runnerRig();
    const result = await gestureCustomTool.execute(services, {
      udid: DEVICE_UDID,
      events: dragTrain,
    });
    const drags = run.mock.calls.filter(([req]) => req.command === "drag");
    expect(drags).toHaveLength(1);
    // The simulator train rests at the Down point for the Up's delay and then
    // jumps; on hardware that rest is the press before the move, not a slow
    // move, which is what a long-press pickup needs.
    expect(drags[0][0]).toMatchObject({ appBundleId: "com.example.app", holdMs: 1500 });
    expect(drags[0][0]).not.toHaveProperty("durationMs");
    expect(result).toEqual({ events: 2 });
  });

  it("maps a Down, Move-at-start, Up train onto a pickup drag: hold, then a timed move", async () => {
    const { run, services } = runnerRig();
    const result = await gestureCustomTool.execute(services, {
      udid: DEVICE_UDID,
      events: pickupTrain,
    });
    const drags = run.mock.calls.filter(([req]) => req.command === "drag");
    expect(drags).toHaveLength(1);
    expect(drags[0][0]).toMatchObject({ holdMs: 800, durationMs: 500 });
    expect(result).toEqual({ events: 3 });
  });

  it("rejects the trains XCTest cannot replay", async () => {
    for (const events of [twoFinger, withWaypoints, moveAtDestination]) {
      const { run, services } = runnerRig();
      await expect(
        gestureCustomTool.execute(services, { udid: DEVICE_UDID, events })
      ).rejects.toBeInstanceOf(InvalidToolInputError);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("declares the runner service only for a train it can replay", () => {
    expect(gestureCustomTool.services({ udid: DEVICE_UDID, events: pressHold })).toHaveProperty(
      "iosDeviceRunner"
    );
    // A train `execute` refuses with authoring guidance must not stand a runner
    // up first: a cold start is an xcodebuild build of up to 15 minutes plus a
    // 120s ready-wait, paid for a request that never reaches the device.
    expect(gestureCustomTool.services({ udid: DEVICE_UDID, events: pickupTrain })).toHaveProperty(
      "iosDeviceRunner"
    );
    expect(gestureCustomTool.services({ udid: DEVICE_UDID, events: twoFinger })).toEqual({});
    expect(gestureCustomTool.services({ udid: DEVICE_UDID, events: withWaypoints })).toEqual({});
    expect(gestureCustomTool.services({ udid: DEVICE_UDID, events: moveAtDestination })).toEqual(
      {}
    );
  });
});

describe("gesture-custom coordinate bounds", () => {
  const coordinates = ["x", "y", "x2", "y2"] as const;
  const withEvent = (patch: Record<string, number>) => ({
    udid: "emulator-5554",
    events: [{ ...twoFinger[0], ...patch }, twoFinger[1]],
  });

  for (const coordinate of coordinates) {
    it.each([-0.1, 1.1, 540])(`rejects ${coordinate} = %s and names it`, (value) => {
      const parsed = gestureCustomTool.zodSchema!.safeParse(withEvent({ [coordinate]: value }));
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues[0].path).toEqual(["events", 0, coordinate]);
    });

    it.each([0, 1])(`accepts ${coordinate} = %s`, (value) => {
      expect(
        gestureCustomTool.zodSchema!.safeParse(withEvent({ [coordinate]: value })).success
      ).toBe(true);
    });
  }

  it("rejects pixel coordinates before reaching the device", async () => {
    const registry = new Registry();
    registry.registerTool(gestureCustomTool);
    const resolveService = vi
      .spyOn(registry, "resolveService")
      .mockRejectedValue(new Error("Unexpected service resolution"));

    await expect(
      registry.invokeTool("gesture-custom", withEvent({ x: 200, y: 390 }))
    ).rejects.toThrow(/Invalid params.*events\.0\.x/);
    expect(resolveService).not.toHaveBeenCalled();
  });
});
