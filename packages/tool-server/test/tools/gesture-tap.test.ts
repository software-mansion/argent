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
  sendCommand: (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
  },
}));

// Stub the delivery-verification entry point so the tool's contract is tested
// in isolation: it passes the caller's `verify` through untouched, runs the
// injection via the action, and spreads the returned check into the result. The
// auto-first-touch policy is covered by the touch-verification unit tests.
type Check = { verified?: boolean; warning?: string };
let mockCheck: Check = {};
const runWithDeliveryVerificationMock = vi.fn(
  async (_api: unknown, _verify: boolean | undefined, action: () => Promise<void>) => {
    await action();
    return mockCheck;
  }
);
vi.mock("../../src/utils/touch-verification", () => ({
  runWithDeliveryVerification: (
    api: unknown,
    verify: boolean | undefined,
    action: () => Promise<void>
  ) => runWithDeliveryVerificationMock(api, verify, action),
  describeVerify: (noun: string) => `verify ${noun}`,
}));

import { gestureTapTool } from "../../src/tools/gesture-tap";

const touchServices = { simulatorServer: {} } as never;

beforeEach(() => {
  sent.length = 0;
  mockCheck = {};
  runWithDeliveryVerificationMock.mockClear();
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

describe("gesture-tap delivery verification", () => {
  it("routes every touch tap through the verification wrapper with the caller's verify flag", async () => {
    // undefined → the wrapper applies the automatic first-touch policy.
    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5 });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      undefined,
      expect.any(Function)
    );

    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5, verify: true });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      true,
      expect.any(Function)
    );

    await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5, verify: false });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      false,
      expect.any(Function)
    );
  });

  it("returns a bare result when no check ran, and still injects the taps", async () => {
    mockCheck = {};
    const result = await gestureTapTool.execute(touchServices, { udid: "X", x: 0.5, y: 0.5 });
    expect(result.tapped).toBe(true);
    expect(result.verified).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
  });

  it("reports verified:true and no warning when the tap observably lands", async () => {
    mockCheck = { verified: true };
    const result = await gestureTapTool.execute(touchServices, {
      udid: "X",
      x: 0.5,
      y: 0.5,
      verify: true,
    });
    expect(result.verified).toBe(true);
    expect(result.warning).toBeUndefined();
    // The touch was still injected (verification wraps, doesn't replace, the tap).
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
  });

  it("surfaces verified:false + a warning when the screen never changes (the wedge)", async () => {
    mockCheck = { verified: false, warning: "warn:no-change" };
    const result = await gestureTapTool.execute(touchServices, {
      udid: "X",
      x: 0.5,
      y: 0.5,
    });
    // The touch was still sent; the result now reports the failed delivery.
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
    expect(result.tapped).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.warning).toBe("warn:no-change");
  });

  it("marks a Chromium tap verified without an observational check (CDP already acks)", async () => {
    const chromium = {
      getViewport: () => ({ width: 1000, height: 800 }),
      dispatchMouseEvent: vi.fn(async () => {}),
    };
    const result = await gestureTapTool.execute({ chromium } as never, {
      udid: "chromium-cdp-9222",
      x: 0.5,
      y: 0.5,
      verify: true,
    });
    expect(result.verified).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(runWithDeliveryVerificationMock).not.toHaveBeenCalled();
  });

  it("leaves a plain Chromium tap result bare (no verified field) when verify is not passed", async () => {
    const chromium = {
      getViewport: () => ({ width: 1000, height: 800 }),
      dispatchMouseEvent: vi.fn(async () => {}),
    };
    const result = await gestureTapTool.execute({ chromium } as never, {
      udid: "chromium-cdp-9222",
      x: 0.5,
      y: 0.5,
    });
    expect(result.tapped).toBe(true);
    expect(result.verified).toBeUndefined();
    expect(runWithDeliveryVerificationMock).not.toHaveBeenCalled();
  });
});
