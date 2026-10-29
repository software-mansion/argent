import { describe, expect, it, vi, beforeEach } from "vitest";
import { Registry, TypedEventEmitter, FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import {
  screenRecordingStopTool,
  createScreenRecordingStopTool,
} from "../src/tools/screen-recording/screen-recording-stop";
import { startCapture, stopCapture } from "../src/tools/screen-recording/capture";

vi.mock("../src/tools/screen-recording/capture", () => ({
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
}));
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFeatureEnabled: () => true,
}));

const start = vi.mocked(startCapture);
const registry = {
  resolveService: vi.fn(async () => ({ streamUrl: "http://127.0.0.1:1234/stream.mjpeg" })),
} as unknown as Registry;
const tool = createScreenRecordingStartTool(registry);

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({
    status: "recording",
    timeLimitSeconds: 180,
    outputFile: "/tmp/video.mp4",
  });
});

describe("recording mode defaults", () => {
  it("preserves existing defaults when mode is omitted", async () => {
    await tool.execute({ session: {} }, { udid: "emulator-5554" }, {} as never);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: "light",
      timeLimitSeconds: 180,
      trimStatic: true,
      watermark: true,
    });
    expect(start.mock.calls[0][1].pointer).toBeDefined();
  });

  it("reports a started recording to the enclosing invocation", async () => {
    const onRecordingOutput = vi.fn();
    const result = await tool.execute({ session: {} }, { udid: "emulator-5554" }, {
      onRecordingOutput,
    } as never);
    expect(onRecordingOutput).toHaveBeenCalledWith("emulator-5554", result.outputFile);
  });

  it("defaults debug to no trimming, markers or watermark", async () => {
    await tool.execute({ session: {} }, { udid: "emulator-5554", mode: "debug" }, {} as never);
    expect(start.mock.calls[0][1]).toMatchObject({
      mode: "debug",
      timeLimitSeconds: 30,
      trimStatic: false,
      watermark: false,
    });
    expect(start.mock.calls[0][1].pointer).toBeUndefined();
  });

  it("caps debug at 120 seconds while preserving the light maximum", async () => {
    await expect(
      tool.execute(
        { session: {} },
        {
          udid: "emulator-5554",
          mode: "debug",
          timeLimitSeconds: 121,
        },
        {} as never
      )
    ).rejects.toThrow("cannot exceed 120");
    expect(registry.resolveService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await tool.execute(
      { session: {} },
      {
        udid: "emulator-5554",
        mode: "debug",
        timeLimitSeconds: 120,
      },
      {} as never
    );
    expect(start.mock.calls[0][1].timeLimitSeconds).toBe(120);
    await tool.execute(
      { session: {} },
      {
        udid: "emulator-5554",
        mode: "light",
        timeLimitSeconds: 600,
      },
      {} as never
    );
    expect(start.mock.calls[1][1].timeLimitSeconds).toBe(600);
  });

  it("allows touch markers in debug recordings", async () => {
    await tool.execute(
      { session: {} },
      { udid: "emulator-5554", mode: "debug", showTouches: true },
      {} as never
    );
    expect(start.mock.calls[0][1].pointer).toBeDefined();
    expect(start.mock.calls[0][1].trimStatic).toBe(false);
  });

  it("rejects static trimming in debug recordings before resolving the device stream", async () => {
    await expect(
      tool.execute(
        { session: {} },
        { udid: "emulator-5554", mode: "debug", trimStatic: true },
        {} as never
      )
    ).rejects.toThrow("require trimStatic");
    expect(registry.resolveService).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  "returns the debug encoding result through the stop tool (%s)",
  async (complete) => {
    const video = { filename: "video.mp4", hostPath: "/tmp/video.mp4" };
    const register = vi.fn().mockResolvedValue(video);
    vi.mocked(stopCapture).mockResolvedValue({
      outputFile: "/tmp/video.mp4",
      sizeBytes: 10,
      durationMs: complete ? 1_000 : null,
      encodingComplete: complete,
      ...(complete ? {} : { warning: "encoder failed" }),
    });
    expect(screenRecordingStopTool.longRunning).toBe(true);
    const result = await screenRecordingStopTool.execute(
      { session: {} },
      { udid: "emulator-5554", outputFile: "/tmp/video.mp4" },
      { artifacts: { register } } as never
    );
    expect(stopCapture).toHaveBeenCalledWith({}, "/tmp/video.mp4");
    expect(result).toMatchObject({
      video,
      encodingComplete: complete,
      durationMs: complete ? 1_000 : null,
    });
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "screen-recording", hostPath: "/tmp/video.mp4" })
    );
    if (!complete) expect(result.warning).toBe("encoder failed");
  }
);

it("explains start and stop calls during registry-owned recording teardown", async () => {
  const registry = new Registry();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urn = "ScreenRecordingSession:emulator-5554";
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => urn,
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: () => pending }),
  });
  registry.registerTool(createScreenRecordingStartTool(registry));
  registry.registerTool(createScreenRecordingStopTool(registry));
  await registry.resolveService(urn);
  const disposing = registry.disposeService(urn);
  try {
    for (const name of ["screen-recording-start", "screen-recording-stop"]) {
      const error = await registry
        .invokeTool(name, { udid: "emulator-5554" })
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("being torn down");
      expect((error as Error).message).toContain(
        "Wait for any in-flight stop or teardown call to finish"
      );
      expect((error as Error).message).toContain("check the outputFile returned by start");
      expect(getFailureSignal(error)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
      );
    }
  } finally {
    release();
    await disposing;
    await registry.dispose();
  }
});

it("uses recording teardown guidance through production registry wiring", async () => {
  const { createRegistry } = await import("../src/utils/setup-registry");
  const { screenRecordingSessionRef } = await import("../src/blueprints/screen-recording-session");
  const registry = createRegistry();
  const ref = screenRecordingSessionRef({
    id: "emulator-5554",
    platform: "android",
    kind: "emulator",
  });
  const api = await registry.resolveService<
    import("../src/blueprints/screen-recording-session").ScreenRecordingSessionApi
  >(ref.urn, ref.options);
  let release!: (result: { outputFile: string; sizeBytes: number; durationMs: number }) => void;
  api.stopping = new Promise((resolve) => {
    release = resolve;
  });
  const disposing = registry.disposeService(ref.urn);
  try {
    const error = await registry
      .invokeTool("screen-recording-stop", { udid: "emulator-5554" })
      .catch((err: Error) => err);
    expect((error as Error).message).toContain("being torn down");
    expect((error as Error).message).toContain("check the outputFile returned by start");
    expect(getFailureSignal(error)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
    );
  } finally {
    release({ outputFile: "/unused/recording.mp4", sizeBytes: 1, durationMs: 0 });
    await disposing;
    await registry.dispose();
  }
});
