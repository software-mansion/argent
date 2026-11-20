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

const { describeIos, describeAndroid, describeChromium } = vi.hoisted(() => ({
  describeIos: vi.fn(),
  describeAndroid: vi.fn(),
  describeChromium: vi.fn(),
}));
vi.mock("../../src/tools/describe/platforms/ios", () => ({ describeIos }));
vi.mock("../../src/tools/describe/platforms/android", () => ({ describeAndroid }));
vi.mock("../../src/tools/describe/platforms/chromium", () => ({ describeChromium }));

import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { createGestureTapTool } from "../../src/tools/gesture-tap";
import type { DescribeFrame, DescribeNode } from "../../src/tools/describe/contract";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";

const gestureTapTool = createGestureTapTool({} as never);

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
  describeIos.mockReset();
  describeAndroid.mockReset();
  describeChromium.mockReset();
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

const SIM_UDID = "00000000-0000-0000-0000-0000000000AB";

function node(role: string, label: string, frame: DescribeFrame): DescribeNode {
  return { role, label, frame, children: [] };
}

function screen(...children: DescribeNode[]) {
  return {
    tree: { role: "root", frame: { x: 0, y: 0, width: 1, height: 1 }, children },
    source: "ax-service",
  };
}

const loginButton = node("AXButton", "Log in", { x: 0.25, y: 0.75, width: 0.5, height: 0.125 });

async function failure(promise: Promise<unknown>): Promise<Error | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => e as Error
  );
}

describe("gesture-tap selector", () => {
  it("takes either a selector or both x and y", () => {
    const schema = gestureTapTool.zodSchema!;
    const selector = { text: "Log in" };
    expect(schema.safeParse({ udid: "X", selector }).success).toBe(true);
    expect(schema.safeParse({ udid: "X", x: 0.5, y: 0.5 }).success).toBe(true);
    expect(schema.safeParse({ udid: "X", selector, x: 0.5 }).success).toBe(false);
    expect(schema.safeParse({ udid: "X", x: 0.5 }).success).toBe(false);
    expect(schema.safeParse({ udid: "X" }).success).toBe(false);
    expect(schema.safeParse({ udid: "X", selector: {} }).success).toBe(false);
  });

  it("taps the centre of the one matching element on an iOS simulator", async () => {
    describeIos.mockResolvedValue(screen(loginButton));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "log in" } });
    expect(sent.map((e) => [e.type, e.x, e.y])).toEqual([
      ["Down", 0.5, 0.8125],
      ["Up", 0.5, 0.8125],
    ]);
  });

  it("prefers the exact match over a container whose label only contains the text", async () => {
    const form = node("AXGroup", "Email, Log in", { x: 0, y: 0.5, width: 1, height: 0.5 });
    const header = node("AXStaticText", "Log in to continue", {
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.05,
    });
    describeIos.mockResolvedValue(screen(form, header, loginButton));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } });
    expect(sent[0]).toMatchObject({ x: 0.5, y: 0.8125 });
  });

  it("reads a container and the leaf inside it as one target", async () => {
    const row = node("AXButton", "Settings", { x: 0, y: 0.2, width: 1, height: 0.1 });
    const label = node("AXStaticText", "Settings", { x: 0.1, y: 0.22, width: 0.3, height: 0.06 });
    describeIos.mockResolvedValue(screen(row, label));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Settings" } });
    expect(sent[0]).toMatchObject({ x: 0.25, y: 0.25 });
  });

  it("refuses an ambiguous selector, listing the candidates, and taps nothing", async () => {
    const other = node("AXButton", "Log in", { x: 0.1, y: 0.1, width: 0.3, height: 0.05 });
    describeIos.mockResolvedValue(screen(loginButton, other));
    const err = await failure(
      gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } })
    );
    expect(err?.message).toContain("matches 2 elements");
    expect(err?.message).toContain('AXButton "Log in"  (0.250,0.750,0.500,0.125)');
    expect(err?.message).toContain('AXButton "Log in"  (0.100,0.100,0.300,0.050)');
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(sent).toEqual([]);
  });

  it("waits briefly for the element to appear", async () => {
    describeIos.mockResolvedValueOnce(screen()).mockResolvedValue(screen(loginButton));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } });
    expect(describeIos).toHaveBeenCalledTimes(3);
    expect(sent[0]).toMatchObject({ x: 0.5, y: 0.8125 });
  });

  it("taps an element that appears while moving at the frame it settles on", async () => {
    const sliding = { ...loginButton, frame: { ...loginButton.frame, y: 0.9 } };
    describeIos
      .mockResolvedValueOnce(screen())
      .mockResolvedValueOnce(screen(sliding))
      .mockResolvedValue(screen(loginButton));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } });
    expect(describeIos).toHaveBeenCalledTimes(4);
    expect(sent[0]).toMatchObject({ x: 0.5, y: 0.8125 });
  });

  it("fails when nothing matches before the wait ends", async () => {
    vi.useFakeTimers();
    try {
      describeIos.mockResolvedValue(screen(loginButton));
      const pending = failure(
        gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Sign up" } })
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending)?.message).toContain(
        'No visible element matches selector {"text":"Sign up"}'
      );
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves against the Android tree on an emulator", async () => {
    describeAndroid.mockResolvedValue({
      ...screen({ ...loginButton, role: "android.widget.Button", identifier: "com.app:id/login" }),
      source: "android-devtools",
    });
    await gestureTapTool.execute(touchServices, {
      udid: "emulator-5554",
      selector: { identifier: "login" },
    });
    expect(sent[0]).toMatchObject({ x: 0.5, y: 0.8125 });
  });

  it("clicks the element's centre in Chromium", async () => {
    const mouse: Array<{ type: string; x: number; y: number }> = [];
    const chromium = {
      getViewport: () => ({ width: 1000, height: 800 }),
      dispatchMouseEvent: vi.fn(async (e: { type: string; x: number; y: number }) => {
        mouse.push(e);
      }),
    };
    describeChromium.mockResolvedValue({ ...screen(loginButton), source: "cdp-dom" });
    await gestureTapTool.execute({ chromium } as never, {
      udid: "chromium-cdp-9222",
      selector: { role: "AXButton" },
    });
    expect(describeChromium).toHaveBeenCalledWith(chromium);
    expect(mouse[1]).toMatchObject({ type: "mousePressed", x: 500, y: 650 });
  });

  it.each([
    ["a physical iPhone", DEVICE_UDID, "ios device"],
    ["a remote iOS simulator", `remote:${SIM_UDID}`, "ios-remote simulator"],
    ["a HarmonyOS device", "harmony-FMR0223C13000649", "harmony device"],
    ["a Mac app", "macos-app-com.example.app", "macos app"],
  ])("refuses a selector on %s and starts no backend", async (_name, udid, where) => {
    expect(gestureTapTool.services!({ udid, selector: { text: "Log in" } })).toEqual({});
    const { run, services } = runnerRig();
    const err = await failure(
      gestureTapTool.execute(services, { udid, selector: { text: "Log in" } })
    );
    expect(err?.message).toContain(`not on ${where}: pass x/y`);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("stops waiting when the call is cancelled", async () => {
    describeIos.mockResolvedValue(screen());
    const controller = new AbortController();
    const pending = failure(
      gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } }, {
        signal: controller.signal,
      } as never)
    );
    controller.abort();
    expect((await pending)?.message).toContain("cancelled");
    expect(sent).toEqual([]);
  });

  it("starts the backend for a selector where one is supported", () => {
    expect(
      gestureTapTool.services!({ udid: SIM_UDID, selector: { text: "Log in" } })
    ).toHaveProperty("simulatorServer");
  });

  it("only considers matches in the frontmost layer", async () => {
    const sheetButton = {
      ...node("AXButton", "Log in", { x: 0.25, y: 0.25, width: 0.5, height: 0.125 }),
      layer: 1,
    };
    describeIos.mockResolvedValue(screen(loginButton, sheetButton));
    await gestureTapTool.execute(touchServices, { udid: SIM_UDID, selector: { text: "Log in" } });
    expect(sent[0]).toMatchObject({ x: 0.5, y: 0.3125 });
  });
});
