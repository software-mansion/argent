import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the touch-event train the tool sends to the simulator-server — the
// multi-tap contract (N Down/Up pairs, one gesture) lives entirely in it.
interface TouchCmd {
  cmd: string;
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
  screen?: number;
}
const sent: TouchCmd[] = [];
// What `sendCommand` reports back: a foldable names the screen a touch went to.
let outcome: { screen?: number } = {};
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: async (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
    return outcome;
  },
}));

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
  outcome = {};
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
    // A device that is not foldable reports no screen, so none is named.
    expect(sent.some((e) => "screen" in e)).toBe(false);
  });

  it("on a foldable, resolves the panel on the first tap and names it on the rest", async () => {
    outcome = { screen: 3 };
    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.4, y: 0.6, clickCount: 3 });
    expect(sent.map((e) => [e.type, e.screen])).toEqual([
      ["Down", undefined],
      ["Up", undefined],
      ["Down", 3],
      ["Up", 3],
      ["Down", 3],
      ["Up", 3],
    ]);
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
