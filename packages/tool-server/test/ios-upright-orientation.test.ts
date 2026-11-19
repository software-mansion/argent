import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { DeviceInfo } from "@argent/registry";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";
import type { UiOrientation } from "../src/tools/describe/contract";
import { sendCommand } from "../src/utils/simulator-client";
import {
  __resetUiOrientationForTests,
  forgetUiOrientation,
  noteUiOrientation,
  readUiOrientation,
  setUiOrientationSourceProvider,
} from "../src/utils/ios-ui-orientation";
import {
  nativeFrameToUi,
  nativePointToUi,
  nativeTreeToUi,
  uiPointToNative,
  uprightCaptureRotation,
} from "../src/utils/ui-orientation";
import {
  fixedPointFromUpright,
  fixedSpaceOf,
  uprightNativeResult,
} from "../src/utils/native-devtools-upright";
import { captureScreenshotUpright } from "../src/utils/rotation-aware-capture";

const SIM = "405655A7-F5FD-4101-9168-148F0F0953D1";
const ORIENTATIONS: UiOrientation[] = [
  "portrait",
  "landscapeLeft",
  "landscapeRight",
  "portraitUpsideDown",
];

const orientationMock = vi.fn<
  () => Promise<{
    interfaceOrientation?: UiOrientation;
    screenFrame?: { width: number; height: number };
  }>
>();

beforeEach(() => {
  __resetUiOrientationForTests();
  orientationMock.mockReset();
  setUiOrientationSourceProvider(async () => ({ orientation: orientationMock }));
});

afterEach(() => {
  setUiOrientationSourceProvider(undefined);
  vi.useRealTimers();
});

describe("ui-orientation maps", () => {
  it("nativePointToUi undoes uiPointToNative in every orientation", () => {
    for (const o of ORIENTATIONS) {
      const p = { x: 0.2, y: 0.7 };
      const back = nativePointToUi(uiPointToNative(p, o), o);
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
    }
  });

  it("turns a frame so that its turned centre is the turned centre point", () => {
    const f = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    for (const o of ORIENTATIONS) {
      const ui = nativeFrameToUi(f, o);
      const centre = nativePointToUi({ x: f.x + f.width / 2, y: f.y + f.height / 2 }, o);
      expect(ui.x + ui.width / 2).toBeCloseTo(centre.x, 9);
      expect(ui.y + ui.height / 2).toBeCloseTo(centre.y, 9);
    }
  });

  // Measured on an iOS 27 simulator: `rotate` LandscapeLeft gives Safari a
  // landscapeRight UI, its back button native-top-right, and a capture with
  // rotation LandscapeLeft upright.
  it("names the simulator-server rotation that captures each UI upright", () => {
    expect(uprightCaptureRotation("portrait")).toBeUndefined();
    expect(uprightCaptureRotation(undefined)).toBeUndefined();
    expect(uprightCaptureRotation("landscapeRight")).toBe("LandscapeLeft");
    expect(uprightCaptureRotation("landscapeLeft")).toBe("LandscapeRight");
    expect(uprightCaptureRotation("portraitUpsideDown")).toBe("PortraitUpsideDown");
    // The measured case: the UI's top-left lies at the native top-right.
    const backButton = nativePointToUi({ x: 0.92, y: 0.1 }, "landscapeRight");
    expect(backButton.x).toBeCloseTo(0.1);
    expect(backButton.y).toBeCloseTo(0.08);
  });

  it("turns every frame of a tree", () => {
    const tree = {
      role: "AXGroup",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        { role: "AXButton", frame: { x: 0.9, y: 0.05, width: 0.05, height: 0.1 }, children: [] },
      ],
    };
    const ui = nativeTreeToUi(tree, "landscapeRight");
    expect(ui.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(ui.children[0]!.frame).toEqual(
      nativeFrameToUi(tree.children[0]!.frame, "landscapeRight")
    );
  });
});

describe("readUiOrientation", () => {
  it("reuses an answer briefly, then asks again", async () => {
    vi.useFakeTimers();
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeLeft" });
    expect((await readUiOrientation(SIM)).orientation).toBe("landscapeLeft");
    expect((await readUiOrientation(SIM)).orientation).toBe("landscapeLeft");
    expect(orientationMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_100);
    await readUiOrientation(SIM);
    expect(orientationMock).toHaveBeenCalledTimes(2);
  });

  it("asks afresh after a rotate, and caches nothing while the UI turns", async () => {
    vi.useFakeTimers();
    orientationMock.mockResolvedValue({ interfaceOrientation: "portrait" });
    noteUiOrientation(SIM, "landscapeLeft");
    expect((await readUiOrientation(SIM)).orientation).toBe("landscapeLeft");
    forgetUiOrientation(SIM);
    await readUiOrientation(SIM);
    await readUiOrientation(SIM);
    expect(orientationMock).toHaveBeenCalledTimes(2);
    // A tree read mid-turn is not cached either.
    noteUiOrientation(SIM, "landscapeRight");
    expect((await readUiOrientation(SIM)).orientation).toBe("portrait");
  });

  it("says why when the daemon fails, and stays silent when none is wired in", async () => {
    orientationMock.mockRejectedValue(new Error("ax-service not connected"));
    const failed = await readUiOrientation(SIM);
    expect(failed.orientation).toBeUndefined();
    expect(failed.unknownReason).toContain("ax-service not connected");

    __resetUiOrientationForTests();
    setUiOrientationSourceProvider(undefined);
    expect(await readUiOrientation(SIM)).toEqual({});
  });
});

/** A stand-in for simulator-server's `/ws` that acks every command and keeps it. */
async function startWs(): Promise<{
  port: number;
  received: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<WsSocket>();
  const wss = await new Promise<WebSocketServer>((resolve) => {
    const s: WebSocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(s)
    );
  });
  wss.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      sock.send(JSON.stringify({ id: msg.id, status: "ok" }));
    });
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    received,
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

function apiFor(port: number, deviceId: string): SimulatorServerApi {
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
    pressKey: () => Promise.resolve(),
    deviceId,
  };
}

const touch = (type: "Down" | "Move" | "Up", x: number, y: number) => ({
  cmd: "touch",
  type,
  x,
  y,
  second_x: null,
  second_y: null,
});

describe("sendCommand on an iOS simulator", () => {
  let ws: Awaited<ReturnType<typeof startWs>>;
  beforeEach(async () => {
    ws = await startWs();
  });
  afterEach(async () => {
    await ws.close();
  });

  it("turns an upright touch into the native space", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeRight" });
    await sendCommand(apiFor(ws.port, SIM), touch("Down", 0.1, 0.2));
    const native = uiPointToNative({ x: 0.1, y: 0.2 }, "landscapeRight");
    expect(ws.received[0]).toMatchObject({ x: native.x, y: native.y });
  });

  it("turns both fingers", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "portraitUpsideDown" });
    await sendCommand(apiFor(ws.port, SIM), {
      ...touch("Down", 0.25, 0.25),
      second_x: 0.75,
      second_y: 0.5,
    });
    expect(ws.received[0]).toMatchObject({ x: 0.75, y: 0.75, second_x: 0.25, second_y: 0.5 });
  });

  it("keeps the orientation of the Down for the Moves and the Up", async () => {
    const api = apiFor(ws.port, SIM);
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeLeft" });
    await sendCommand(api, touch("Down", 0.5, 0.1));
    // The UI turns mid-gesture; the gesture does not.
    forgetUiOrientation(SIM);
    orientationMock.mockResolvedValue({ interfaceOrientation: "portrait" });
    await sendCommand(api, touch("Move", 0.5, 0.5));
    await sendCommand(api, touch("Up", 0.5, 0.9));
    const expected = [0.1, 0.5, 0.9].map((y) => uiPointToNative({ x: 0.5, y }, "landscapeLeft"));
    expect(ws.received.map((m) => ({ x: m.x, y: m.y }))).toEqual(expected);
    expect(orientationMock).toHaveBeenCalledTimes(1);
  });

  it("sends the touch unturned, with a note, when the orientation cannot be read", async () => {
    orientationMock.mockRejectedValue(new Error("boom"));
    const outcome = await sendCommand(apiFor(ws.port, SIM), touch("Down", 0.1, 0.2));
    expect(ws.received[0]).toMatchObject({ x: 0.1, y: 0.2 });
    expect(outcome.warning).toContain("portrait-native");
  });

  it("leaves an Android device and other commands alone", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeRight" });
    await sendCommand(apiFor(ws.port, "emulator-5554"), touch("Down", 0.1, 0.2));
    await sendCommand(apiFor(ws.port, SIM), { cmd: "button", button: "home", direction: "Down" });
    expect(ws.received[0]).toMatchObject({ x: 0.1, y: 0.2 });
    expect(orientationMock).not.toHaveBeenCalled();
  });

  it("forgets the orientation when it rotates the device", async () => {
    noteUiOrientation(SIM, "landscapeRight");
    await sendCommand(apiFor(ws.port, SIM), { cmd: "rotate", direction: "Portrait" });
    orientationMock.mockResolvedValue({ interfaceOrientation: "portrait" });
    expect((await readUiOrientation(SIM)).orientation).toBe("portrait");
  });
});

describe("captureScreenshotUpright on an iOS simulator", () => {
  const device: DeviceInfo = { id: SIM, platform: "ios", kind: "simulator" };
  const api = apiFor(0, SIM);

  it("captures with the rotation that makes the UI upright", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeRight" });
    const capture = vi.fn(async () => ({ url: "u", path: "/nonexistent.png" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await captureScreenshotUpright(api, device, undefined, undefined, 0.5, capture);
    expect(capture).toHaveBeenCalledWith(api, "LandscapeLeft", undefined, 0.5);
  });

  it("lets an explicit rotation win without asking", async () => {
    const capture = vi.fn(async () => ({ url: "u", path: "p" }));
    await captureScreenshotUpright(api, device, "Portrait", undefined, undefined, capture);
    expect(capture).toHaveBeenCalledWith(api, "Portrait", undefined, undefined);
    expect(orientationMock).not.toHaveBeenCalled();
  });

  it("captures a portrait UI unturned, and says so when it could not read", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "portrait" });
    const capture = vi.fn(async () => ({ url: "u", path: "p" }));
    expect(await captureScreenshotUpright(api, device, undefined, undefined, 1, capture)).toEqual({
      url: "u",
      path: "p",
    });
    expect(capture).toHaveBeenCalledWith(api, undefined, undefined, 1);

    __resetUiOrientationForTests();
    orientationMock.mockRejectedValue(new Error("down"));
    const result = await captureScreenshotUpright(api, device, undefined, undefined, 1, capture);
    expect(result.note).toContain("could not be read");
  });
});

describe("native-devtools results on a turned UI", () => {
  const NATIVE = { width: 402, height: 874 };

  it("turns describeScreen's fixed-space fields and leaves view-relative ones", () => {
    const raw = {
      screenFrame: { x: 0, y: 0, width: 402, height: 874 },
      elements: [
        {
          frame: { x: 362, y: 40, width: 30, height: 60 },
          tapPoint: { x: 377, y: 70 },
          normalizedFrame: { x: 362 / 402, y: 40 / 874, width: 30 / 402, height: 60 / 874 },
          normalizedTapPoint: { x: 377 / 402, y: 70 / 874 },
          label: "Back",
        },
      ],
    };
    const space = fixedSpaceOf(raw, { orientation: "landscapeRight" });
    expect(space).toEqual({ orientation: "landscapeRight", screen: NATIVE });
    const ui = uprightNativeResult("ViewHierarchy.describeScreen", raw, space!);
    expect(ui.screenFrame).toEqual({ x: 0, y: 0, width: 874, height: 402 });
    const el = ui.elements[0]!;
    expect(el.label).toBe("Back");
    // Near the native top-right is near the UI's top-left.
    expect(el.tapPoint.x).toBeCloseTo(70);
    expect(el.tapPoint.y).toBeCloseTo(25);
    expect(el.normalizedTapPoint.x).toBeCloseTo(70 / 874);
    expect(el.frame.width).toBeCloseTo(60);
    expect(el.frame.height).toBeCloseTo(30);
  });

  it("turns a view's screenFrame but not its frame, windowFrame or bounds", () => {
    const view = {
      frame: { x: 1, y: 2, width: 3, height: 4 },
      windowFrame: { x: 5, y: 6, width: 7, height: 8 },
      screenFrame: { x: 0, y: 0, width: 100, height: 50 },
      subviews: [{ screenFrame: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    const ui = uprightNativeResult(
      "ViewHierarchy.findViews",
      { matches: [view] },
      {
        orientation: "portraitUpsideDown",
        screen: NATIVE,
      }
    );
    const m = ui.matches[0]!;
    expect(m.frame).toEqual(view.frame);
    expect(m.windowFrame).toEqual(view.windowFrame);
    expect(m.screenFrame.x).toBeCloseTo(302);
    expect(m.screenFrame.y).toBeCloseTo(824);
    expect(m.subviews[0]!.screenFrame.x).toBeCloseTo(392);
  });

  it("swaps getFullHierarchy's screen and uses its own orientation", () => {
    const raw = { windows: [], screen: { ...NATIVE, interfaceOrientation: "landscapeLeft" } };
    const space = fixedSpaceOf(raw, { orientation: "portrait" });
    expect(space?.orientation).toBe("landscapeLeft");
    const ui = uprightNativeResult("ViewHierarchy.getFullHierarchy", raw, space!);
    expect(ui.screen).toEqual({ width: 874, height: 402, interfaceOrientation: "landscapeLeft" });
  });

  it("looks up the native point under an upright one", () => {
    const space = { orientation: "landscapeRight" as const, screen: NATIVE };
    const upright = { x: 70, y: 25 };
    const fixed = fixedPointFromUpright(upright, space);
    const back = nativePointToUi({ x: fixed.x / 402, y: fixed.y / 874 }, "landscapeRight");
    expect(back.x * 874).toBeCloseTo(70);
    expect(back.y * 402).toBeCloseTo(25);
  });

  it("needs no space for a portrait UI or an unknown size", () => {
    expect(fixedSpaceOf({}, { orientation: "portrait", nativeScreen: NATIVE })).toBeUndefined();
    expect(fixedSpaceOf({}, { orientation: "landscapeLeft" })).toBeUndefined();
    expect(fixedSpaceOf({}, { orientation: "landscapeLeft", nativeScreen: NATIVE })).toEqual({
      orientation: "landscapeLeft",
      screen: NATIVE,
    });
  });
});
