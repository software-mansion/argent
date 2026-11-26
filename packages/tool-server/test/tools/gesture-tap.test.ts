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
const sentAt: number[] = [];
let downWarning: string | undefined;
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: async (_api: unknown, cmd: TouchCmd) => {
    sent.push(cmd);
    sentAt.push(Date.now());
    return cmd.type === "Down" && downWarning !== undefined ? { warning: downWarning } : {};
  },
  onAttachClose: () => {},
}));

// Stub the delivery check so the tool's contract is tested on its own: it
// passes the caller's `verify` and device through, runs the injection inside
// the check, and folds the outcome into its result. The check policy itself is
// covered by test/utils/touch-verification.test.ts.
let mockCheck: { verified?: boolean; warning?: string } = {};
const runWithDeliveryVerificationMock = vi.fn(
  async (
    _api: unknown,
    _verify: boolean | undefined,
    action: () => Promise<void>,
    _device?: unknown
  ) => {
    await action();
    return mockCheck;
  }
);
vi.mock("../../src/utils/touch-verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/touch-verification")>()),
  runWithDeliveryVerification: (...args: Parameters<typeof runWithDeliveryVerificationMock>) =>
    runWithDeliveryVerificationMock(...args),
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
  sentAt.length = 0;
  downWarning = undefined;
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

  it("physical iOS: a count above 2 still rides one runner command, documented as looped single taps", async () => {
    // Hardware has no N-tap API, so the runner loops single taps; the tool
    // sends the count through unchanged and the description says how the
    // taps land rather than refusing the request.
    const { run, services } = runnerRig();
    await gestureTapTool.execute(services, { udid: DEVICE_UDID, x: 0.5, y: 0.5, clickCount: 3 });
    const taps = run.mock.calls.filter(([req]) => req.command === "tap");
    expect(taps).toHaveLength(1);
    expect(taps[0][0]).toMatchObject({ numberOfTaps: 3 });
    expect(gestureTapTool.zodSchema!.shape.clickCount.description).toContain(
      "higher counts loop single taps, which a double-tap recognizer may pair"
    );
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
    [
      "an iOS simulator",
      "00000000-0000-0000-0000-0000000000AB",
      "ios simulator takes no right-click",
      true,
    ],
    ["an Android emulator", "emulator-5554", "android emulator takes no right-click", true],
    ["a physical iPhone", DEVICE_UDID, "ios device takes no right-click", true],
    [
      "a Chromium app",
      "chromium-cdp-9222",
      "argent does not support a right-click on a chromium app yet",
      false,
    ],
  ])("refuses a right-click on %s and starts no backend", async (_name, udid, refusal, hold) => {
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
    expect(err?.message).toContain(refusal);
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

describe("gesture-tap modifiers", () => {
  it("names each held key one time in the messages", () => {
    const params = {
      udid: "macos-app-com.example",
      x: 0.5,
      y: 0.25,
      modifiers: ["command", "shift", "command"],
    };
    const interaction = gestureTapTool.interaction!;
    expect(interaction.startedMsg!({ params } as never)).toBe(
      "Tapping at (50%, 25%) holding command+shift"
    );
    expect(interaction.completedMsg!({ params, result: {} } as never)).toBe(
      "Tapped at (50%, 25%) holding command+shift"
    );
  });

  it("takes each modifier key and combinations, and rejects unknown names or more than four at the schema", () => {
    const schema = gestureTapTool.zodSchema!;
    for (const modifiers of [
      undefined,
      [],
      ["control"],
      ["option"],
      ["shift"],
      ["command"],
      ["command", "shift"],
      ["control", "option", "shift", "command"],
    ]) {
      expect(schema.safeParse({ udid: "X", x: 0.5, y: 0.5, modifiers }).success).toBe(true);
    }
    for (const modifiers of [
      ["cmd"],
      ["Command"],
      ["command", "alt"],
      "command",
      ["control", "option", "shift", "command", "command"],
    ]) {
      expect(schema.safeParse({ udid: "X", x: 0.5, y: 0.5, modifiers }).success).toBe(false);
    }
  });

  it.each([
    [
      "an iOS simulator",
      "00000000-0000-0000-0000-0000000000AB",
      "ios simulator takes no modifier keys in a tap.",
    ],
    ["an Android emulator", "emulator-5554", "android emulator takes no modifier keys in a tap."],
    ["a physical iPhone", DEVICE_UDID, "ios device takes no modifier keys in a tap."],
    [
      "a Chromium app",
      "chromium-cdp-9222",
      "argent does not support modifier keys in a tap on a chromium app yet.",
    ],
  ])("refuses modifier keys on %s and starts no backend", async (_name, udid, refusal) => {
    const params = { udid, x: 0.5, y: 0.5, modifiers: ["command" as const] };
    expect(gestureTapTool.services!(params)).toEqual({});
    const { run } = runnerRig();
    const err = await gestureTapTool
      .execute({ simulatorServer: {}, iosDeviceRunner: { udid, run } } as never, params)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain(refusal);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    // Nothing reached a device: no touch, no runner command.
    expect(sent).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a right-click before the modifier keys when a tap has both", async () => {
    const udid = "emulator-5554";
    const err = await gestureTapTool
      .execute(touchServices, { udid, x: 0.5, y: 0.5, button: "right", modifiers: ["shift"] })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain("android emulator takes no right-click");
    expect(err?.message).not.toContain("modifier keys");
    expect(sent).toEqual([]);
  });

  it("taps as usual on a touch device when the modifier list is empty", async () => {
    const udid = "00000000-0000-0000-0000-0000000000AB";
    expect(gestureTapTool.services!({ udid, x: 0.5, y: 0.5, modifiers: [] })).not.toEqual({});
    await gestureTapTool.execute(touchServices, { udid, x: 0.5, y: 0.5, modifiers: [] });
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
  });
});

describe("gesture-tap delivery check", () => {
  const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

  it("passes the caller's verify flag and the resolved device to the check", async () => {
    await gestureTapTool.execute(touchServices, { udid: IOS_UDID, x: 0.5, y: 0.5, verify: true });
    // The device is what keeps the recover-touch-injection hint off Android.
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      true,
      expect.any(Function),
      { id: IOS_UDID, platform: "ios", kind: "simulator" }
    );
    await gestureTapTool.execute(touchServices, { udid: "emulator-5554", x: 0.5, y: 0.5 });
    expect(runWithDeliveryVerificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      undefined,
      expect.any(Function),
      { id: "emulator-5554", platform: "android", kind: "emulator" }
    );
  });

  it("reports verified:false and the warning when the screen did not change", async () => {
    mockCheck = { verified: false, warning: "warn:no-change" };
    const result = await gestureTapTool.execute(touchServices, { udid: IOS_UDID, x: 0.5, y: 0.5 });
    expect(sent.map((e) => e.type)).toEqual(["Down", "Up"]);
    expect(result).toMatchObject({ tapped: true, verified: false, warning: "warn:no-change" });
  });

  it("keeps a foldable panel warning next to the delivery warning", async () => {
    downWarning = "warn:panel";
    mockCheck = { verified: false, warning: "warn:no-change" };
    const result = await gestureTapTool.execute(touchServices, { udid: IOS_UDID, x: 0.5, y: 0.5 });
    expect(result.warning).toBe("warn:panel warn:no-change");
  });

  it("leaves the result bare when no check ran", async () => {
    const result = await gestureTapTool.execute(touchServices, { udid: IOS_UDID, x: 0.5, y: 0.5 });
    expect(result).not.toHaveProperty("verified");
    expect(result).not.toHaveProperty("warning");
  });

  it("stamps timestampMs at the first Down, not before the frame capture", async () => {
    // react-profiler-analyze computes commit offsets from this field.
    const CAPTURE_MS = 60;
    runWithDeliveryVerificationMock.mockImplementationOnce(async (_api, _verify, action) => {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_MS));
      await action();
      return { verified: true };
    });
    const result = await gestureTapTool.execute(touchServices, { udid: IOS_UDID, x: 0.5, y: 0.5 });
    expect(sentAt[0] - result.timestampMs).toBeLessThan(CAPTURE_MS / 2);
  });
});
