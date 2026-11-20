import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getFailureSignal,
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";

vi.mock("../src/utils/ios-device/devicectl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-device/devicectl")>();
  return { ...actual, listIosPhysicalDevices: vi.fn() };
});
vi.mock("../src/tools/screen-recording/ios-device-stream/ios-screen-stream", () => ({
  startIosScreenStream: vi.fn(),
}));
vi.mock("../src/tools/screen-recording/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/screen-recording/capture")>();
  return { ...actual, requireFfmpeg: vi.fn(), startCapture: vi.fn() };
});
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

import { listIosPhysicalDevices } from "../src/utils/ios-device/devicectl";
import { startIosScreenStream } from "../src/tools/screen-recording/ios-device-stream/ios-screen-stream";
import { requireFfmpeg, startCapture } from "../src/tools/screen-recording/capture";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import {
  NO_TOUCH_MARKERS_WARNING,
  startIosDeviceCapture,
} from "../src/tools/screen-recording/ios-device-stream/start-device-capture";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";

const mockList = vi.mocked(listIosPhysicalDevices);
const mockStream = vi.mocked(startIosScreenStream);
const mockRequireFfmpeg = vi.mocked(requireFfmpeg);
const mockStartCapture = vi.mocked(startCapture);

const UDID = "00008140-001A2B3C4D5E801C";
const NAME = "Patrick’s iPhone";
const STARTED = { status: "recording", timeLimitSeconds: 30, outputFile: "/tmp/x.mp4" } as const;

function phone(
  overrides: Partial<Awaited<ReturnType<typeof listIosPhysicalDevices>>[number]> = {}
) {
  return {
    udid: UDID,
    name: NAME,
    model: "iPhone 16 Pro",
    osVersion: "26.1",
    developerModeEnabled: true,
    pairingState: "paired",
    transportType: "wired",
    tunnelState: "connected",
    ...overrides,
  };
}

const OPTS = { timeLimitSeconds: 30, watermark: false, trimStatic: true, showTouches: undefined };

async function makeSession(): Promise<ScreenRecordingSessionApi> {
  const device: DeviceInfo = { id: UDID, platform: "ios", kind: "device" };
  const instance = await screenRecordingSessionBlueprint.factory({}, device, { device } as never);
  return instance.api;
}

let close: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  close = vi.fn<() => void>();
  mockRequireFfmpeg.mockResolvedValue("/fake/ffmpeg");
  mockList.mockResolvedValue([phone()]);
  mockStream.mockResolvedValue({
    streamUrl: "http://127.0.0.1:5555/",
    deviceName: NAME,
    close,
  });
  mockStartCapture.mockResolvedValue(STARTED as never);
});

describe("startIosDeviceCapture", () => {
  it("starts the helper with the devicectl name and hands its stream to startCapture", async () => {
    const api = await makeSession();
    const result = await startIosDeviceCapture(api, UDID, OPTS);

    expect(result).toEqual(STARTED);
    expect(mockStream).toHaveBeenCalledWith(NAME);
    expect(mockStartCapture).toHaveBeenCalledWith(api, {
      streamUrl: "http://127.0.0.1:5555/",
      timeLimitSeconds: 30,
      watermark: false,
      trimStatic: true,
      releaseStreamSource: close,
    });
  });

  it("warns that no touch markers are drawn only when showTouches is asked for", async () => {
    const api = await makeSession();
    const withTouches = await startIosDeviceCapture(api, UDID, { ...OPTS, showTouches: true });
    expect(withTouches).toEqual({ ...STARTED, warning: NO_TOUCH_MARKERS_WARNING });

    const without = await startIosDeviceCapture(api, UDID, { ...OPTS, showTouches: false });
    expect(without).not.toHaveProperty("warning");
  });

  it("refuses a second recording before the helper starts", async () => {
    const api = await makeSession();
    api.startPending = true;

    await expect(startIosDeviceCapture(api, UDID, OPTS)).rejects.toThrow();
    expect(mockRequireFfmpeg).not.toHaveBeenCalled();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("fails on missing ffmpeg before the helper compiles or prompts", async () => {
    const api = await makeSession();
    mockRequireFfmpeg.mockRejectedValue(
      new FailureError("no ffmpeg", {
        error_code: FAILURE_CODES.SCREEN_RECORDING_FFMPEG_NOT_FOUND,
        failure_stage: "screen_recording_resolve_ffmpeg",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
      })
    );

    const err = await startIosDeviceCapture(api, UDID, OPTS).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_FFMPEG_NOT_FOUND);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("fails before the helper starts when the udid is not a connected iPhone", async () => {
    const api = await makeSession();
    mockList.mockResolvedValue([phone({ udid: "00008110-000978540290401E", name: "Other" })]);

    const err = await startIosDeviceCapture(api, UDID, OPTS).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND
    );
    expect((err as Error).message).toMatch(/not connected/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("fails before the helper starts when the iPhone is reachable only over the network", async () => {
    const api = await makeSession();
    mockList.mockResolvedValue([phone({ transportType: "localNetwork" })]);

    const err = await startIosDeviceCapture(api, UDID, OPTS).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND
    );
    expect((err as Error).message).toMatch(/USB cable/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("propagates a startCapture failure; releasing the helper is startCapture's job", async () => {
    const api = await makeSession();
    mockStartCapture.mockRejectedValue(new Error("stream open failed"));

    await expect(startIosDeviceCapture(api, UDID, OPTS)).rejects.toThrow("stream open failed");
    // startCapture owns the release on its failure paths (covered in
    // screen-recording.test.ts); it must have been handed the helper's close.
    expect(mockStartCapture.mock.calls[0]![1].releaseStreamSource).toBe(close);
  });
});

describe("screen-recording-start on a cabled iPhone", () => {
  it("routes to the helper, skipping the tvOS probe and simulator-server", async () => {
    const resolveService = vi.fn();
    const tool = createScreenRecordingStartTool({ resolveService } as unknown as Registry);
    const api = await makeSession();

    const result = await tool.execute(
      { session: api } as never,
      { udid: UDID, timeLimitSeconds: 30, showTouches: true },
      undefined as never
    );

    expect(result).toEqual({ ...STARTED, warning: NO_TOUCH_MARKERS_WARNING });
    expect(mockStream).toHaveBeenCalledWith(NAME);
    expect(resolveService).not.toHaveBeenCalled();
    expect(vi.mocked(isTvOsSimulator)).not.toHaveBeenCalled();
  });
});
