import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the touch-event train the tool sends to the simulator-server — the
// multi-tap contract (N Down/Up pairs, one gesture) lives entirely in it.
interface TouchCmd {
  cmd: string;
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
}
const sent: TouchCmd[] = [];
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: async (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
    return {};
  },
}));

import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { gestureTapTool } from "../../src/tools/gesture-tap";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";

const touchServices = { simulatorServer: {} } as never;

// Physical-iOS UDID shape (8 hex, dash, 16 hex) routes to the iosDevice
// branch (see utils/device-info.ts).
const DEVICE_UDID = "00008110-000978540290401E";

// The device branch reads the viewport first, then taps; everything rides
// the runner's `run`.
function runnerRig() {
  setCurrentIosDeviceApp(DEVICE_UDID, "com.example.app");
  const run = vi.fn(async (req: Record<string, unknown>) =>
    req.command === "viewport" ? { x: 0, y: 0, width: 390, height: 844 } : {}
  );
  return { run, services: { iosDeviceRunner: { udid: DEVICE_UDID, run } } as never };
}

beforeEach(() => {
  sent.length = 0;
});

describe("gesture-tap", () => {
  it("dispatches a single Down/Up pair by default", async () => {
    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5 });
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
  });

  it("dispatches clickCount Down/Up pairs as ONE gesture on touch platforms", async () => {
    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.4, y: 0.6, clickCount: 3 });
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up", "Down", "Up", "Down", "Up"]);
    // Every tap lands on the same point — a multi-tap, not a gesture path.
    expect(sent.every((e) => e.x === 0.4 && e.y === 0.6)).toBe(true);
  });

  it("physical iOS: a multi-tap rides ONE runner command carrying numberOfTaps", async () => {
    // Fake timers pin the no-sleep contract: the old device branch awaited
    // one tapAt wire round-trip per tap with a 100ms sleep between. Under
    // fake timers that implementation never resolves. The runner owns the
    // inter-tap timing on-device, so no gap belongs on this side of the wire.
    vi.useFakeTimers();
    try {
      const { run, services } = runnerRig();
      await gestureTapTool.execute(services, {
        udid: DEVICE_UDID,
        x: 0.5,
        y: 0.5,
        clickCount: 2,
      });
      const taps = run.mock.calls.filter(([req]) => req.command === "tap");
      expect(taps).toHaveLength(1);
      expect(taps[0][0]).toMatchObject({
        command: "tap",
        appBundleId: "com.example.app",
        numberOfTaps: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("physical iOS: a count above 2 still rides one runner command, documented as separate taps", async () => {
    // Hardware has no N-tap API, so the runner loops single taps; the tool
    // sends the count through unchanged and the description says the taps
    // land separately rather than refusing the request.
    const { run, services } = runnerRig();
    await gestureTapTool.execute(services, { udid: DEVICE_UDID, x: 0.5, y: 0.5, clickCount: 3 });
    const taps = run.mock.calls.filter(([req]) => req.command === "tap");
    expect(taps).toHaveLength(1);
    expect(taps[0][0]).toMatchObject({ numberOfTaps: 3 });
    expect(gestureTapTool.zodSchema!.shape.clickCount.description).toContain("separate taps");
  });

  it("physical iOS: a single tap keeps its pre-numberOfTaps wire shape", async () => {
    const { run, services } = runnerRig();
    await gestureTapTool.execute(services, { udid: DEVICE_UDID, x: 0.5, y: 0.5 });
    const taps = run.mock.calls.filter(([req]) => req.command === "tap");
    expect(taps).toHaveLength(1);
    expect(taps[0][0]).toEqual({
      command: "tap",
      appBundleId: "com.example.app",
      x: 195,
      y: 422,
    });
  });

  it("escalates the CDP clickCount per click on chromium so dblclick fires", async () => {
    const mouse: Array<{ type: string; clickCount?: number }> = [];
    const chromium = {
      getViewport: () => ({ width: 1000, height: 800 }),
      dispatchMouseEvent: vi.fn(async (e: { type: string; clickCount?: number }) => {
        mouse.push(e);
      }),
    };
    await gestureTapTool.execute({ chromium } as never, {
      udid: "chromium-cdp-9222",
      x: 0.5,
      y: 0.5,
      clickCount: 2,
    });
    // The browser's click counter drives dblclick: presses carry 1, then 2.
    expect(mouse.map((e) => `${e.type}:${e.clickCount ?? ""}`)).toEqual([
      "mouseMoved:",
      "mousePressed:1",
      "mouseReleased:1",
      "mousePressed:2",
      "mouseReleased:2",
    ]);
  });
});

describe("gesture-tap button", () => {
  it("takes left and right, and rejects any other button at the schema", () => {
    const schema = gestureTapTool.zodSchema!;
    for (const button of ["left", "right", undefined]) {
      expect(schema.safeParse({ udid: "X", x: 0.5, y: 0.5, button }).success).toBe(true);
    }
    for (const button of ["middle", "Right", 2]) {
      expect(schema.safeParse({ udid: "X", x: 0.5, y: 0.5, button }).success).toBe(false);
    }
  });

  it.each([
    ["an iOS simulator", "00000000-0000-0000-0000-0000000000AB", "ios simulator", true],
    ["an Android emulator", "emulator-5554", "android emulator", true],
    ["a physical iPhone", DEVICE_UDID, "ios device", true],
    ["a Chromium app", "chromium-cdp-9222", "chromium app", false],
  ])("refuses a right-click on %s and starts no backend", async (_name, udid, named, hold) => {
    expect(gestureTapTool.services!({ udid, x: 0.5, y: 0.5, button: "right" })).toEqual({});
    const { run } = runnerRig();
    const err = await gestureTapTool
      .execute({ simulatorServer: {}, iosDeviceRunner: { udid, run } } as never, {
        udid,
        x: 0.5,
        y: 0.5,
        button: "right",
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain(`${named} takes no right-click`);
    expect(err?.message.includes("gesture-custom")).toBe(hold);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    // Nothing reached a device: no touch, no runner command.
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("sends a touch down and up on a touch device when the button is left", async () => {
    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5, button: "left" });
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
  });
});
