import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";
import type { ChildProcess } from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock("../src/tools/screen-recording/mjpeg-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/tools/screen-recording/mjpeg-stream")>();
  // readJpegDimensions stays real (it is exercised directly further down).
  return { ...actual, openMjpegStream: vi.fn() };
});
vi.mock("../src/tools/screen-recording/watermark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/screen-recording/watermark")>();
  return {
    ...actual,
    resolveFfmpeg: vi.fn(async () => "/fake/ffmpeg"),
    writeLogoTemp: vi.fn(async () => "/tmp/fake-logo.png"),
  };
});

import { spawn } from "child_process";
import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import { startCapture, stopCapture, framesDue } from "../src/tools/screen-recording/capture";
import { openMjpegStream, readJpegDimensions } from "../src/tools/screen-recording/mjpeg-stream";
import { resolveFfmpeg } from "../src/tools/screen-recording/watermark";
import {
  __resetActiveScreenRecordingsForTesting,
  getActiveScreenRecordings,
} from "../src/utils/screen-recording-reminder";

const mockSpawn = vi.mocked(spawn);
const mockOpenStream = vi.mocked(openMjpegStream);
const mockResolveFfmpeg = vi.mocked(resolveFfmpeg);

const IOS_UDID = "6DBF83B4-0000-0000-0000-000000000000";
const ANDROID_SERIAL = "emulator-5554";
const STREAM_URL = "http://127.0.0.1:54321/stream.mjpeg";
/** Grace the start holds after spawning ffmpeg before declaring it live. */
const READY_GRACE_MS = 800;

/** Minimal JPEG: SOI + SOF0 declaring the frame size + EOI. */
function fakeJpeg(width = 1320, height = 2868): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffd8, 0); // SOI
  sof.writeUInt16BE(0xffc0, 2); // SOF0
  sof.writeUInt16BE(17, 4); // segment length
  sof.writeUInt8(8, 6); // precision
  sof.writeUInt16BE(height, 7);
  sof.writeUInt16BE(width, 9);
  sof.writeUInt16BE(0xffd9, 17); // EOI
  return sof;
}

class FakeStdin extends EventEmitter {
  writable = true;
  writableLength = 0;
  ended = false;
  writes: Buffer[] = [];
  write = vi.fn((chunk: Buffer) => {
    this.writes.push(chunk);
    return true;
  });
  end = vi.fn(() => {
    this.ended = true;
    this.writable = false;
  });
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  /** Simulate the process ending: stamps exitCode/signalCode, emits 'exit'. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  /** ffmpeg's real behaviour: stdin EOF finalizes the file and it exits. */
  exitOnStdinEnd(code = 0): void {
    this.stdin.end.mockImplementation(() => {
      this.stdin.ended = true;
      this.stdin.writable = false;
      queueMicrotask(() => this.exit(code));
    });
  }
}

interface FakeStream {
  latest: Buffer | null;
  frameCount: number;
  error: Error | null;
  waitForFirstFrame: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeStream(overrides: Partial<FakeStream> = {}): FakeStream {
  const frame = fakeJpeg();
  const stream: FakeStream = {
    latest: frame,
    frameCount: 1,
    error: null,
    waitForFirstFrame: vi.fn(async () => frame),
    close: vi.fn(),
    ...overrides,
  };
  mockOpenStream.mockResolvedValueOnce(stream as never);
  return stream;
}

function fakeChild(): FakeChild {
  const child = new FakeChild();
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
  return child;
}

async function makeSession(device: DeviceInfo): Promise<ScreenRecordingSessionApi> {
  // The payload argument is unused by this factory; options carry the device.
  const instance = await screenRecordingSessionBlueprint.factory({}, device, {
    device,
  } as never);
  return instance.api;
}

/**
 * Drive a start through its fail-fast grace. With fake timers the grace timer
 * has to be advanced by hand; `flush` lets the promise chain settle first.
 */
async function startAndSettle(
  api: ScreenRecordingSessionApi,
  params: { timeLimitSeconds?: number; watermark?: boolean } = {}
): Promise<Awaited<ReturnType<typeof startCapture>>> {
  const promise = startCapture(api, {
    streamUrl: STREAM_URL,
    timeLimitSeconds: params.timeLimitSeconds ?? 180,
    watermark: params.watermark ?? false,
  });
  // Mark it handled: a start that rejects while the timers below are being
  // advanced would otherwise surface as an unhandled rejection, even though
  // the caller awaits the same promise for its error.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
  return promise;
}

const iosDevice: DeviceInfo = { id: IOS_UDID, platform: "ios", kind: "simulator" } as DeviceInfo;
const androidDevice: DeviceInfo = {
  id: ANDROID_SERIAL,
  platform: "android",
  kind: "emulator",
} as DeviceInfo;

beforeEach(() => {
  __resetActiveScreenRecordingsForTesting();
  mockSpawn.mockReset();
  mockOpenStream.mockReset();
  mockResolveFfmpeg.mockReset();
  mockResolveFfmpeg.mockResolvedValue("/fake/ffmpeg");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("screen-recording session blueprint", () => {
  it("rejects a factory call without a resolved device", async () => {
    try {
      await screenRecordingSessionBlueprint.factory({}, iosDevice, {} as never);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_FACTORY_OPTIONS_MISSING
      );
    }
  });

  it("dispose reaps a child whose start is still mid-readiness", async () => {
    const instance = await screenRecordingSessionBlueprint.factory({}, iosDevice, {
      device: iosDevice,
    } as never);
    const child = new FakeChild();
    instance.api.pendingChild = child as unknown as ChildProcess;

    await instance.dispose();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(instance.api.pendingChild).toBeNull();
  });

  it("rejects platforms that cannot record", async () => {
    try {
      await screenRecordingSessionBlueprint.factory({}, iosDevice, {
        device: { id: "chromium-1", platform: "chromium", kind: "app" },
      } as never);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_WRONG_PLATFORM);
    }
  });

  it("dispose stops the pump, closes the stream and finalizes via stdin EOF", async () => {
    const instance = await screenRecordingSessionBlueprint.factory({}, iosDevice, {
      device: iosDevice,
    } as never);
    const api = instance.api;
    const stream = fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api);

    await instance.dispose();

    expect(child.stdin.ended).toBe(true);
    expect(stream.close).toHaveBeenCalled();
    expect(api.pumpTimer).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });
});

describe("screen recording capture", () => {
  it("encodes the paced frame pipe, stamps the session and registers the reminder", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();

    const result = await startAndSettle(api, { timeLimitSeconds: 60 });

    expect(result).toMatchObject({ status: "recording", timeLimitSeconds: 60 });
    expect(mockOpenStream).toHaveBeenCalledWith(STREAM_URL, expect.any(Number));
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe("/fake/ffmpeg");
    expect(args).toEqual(expect.arrayContaining(["-f", "image2pipe", "-framerate", "30"]));
    // Output must be the file the caller was told about.
    expect((args as string[]).at(-1)).toBe(result.outputFile);
    expect(api.recordingActive).toBe(true);
    expect(api.captureProcess).toBe(child as unknown as ChildProcess);
    expect(getActiveScreenRecordings()).toHaveLength(1);
  });

  it("stamps the watermark in the same pass when the flag is on", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    fakeChild();

    await startAndSettle(api, { watermark: true });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("-filter_complex");
    // Geometry comes from the first frame's JPEG header (1320x2868), so the
    // graph must carry a concrete crop box rather than a placeholder.
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("crop=378:116:40:2728");
    expect(args).toContain("/tmp/fake-logo.png");
  });

  it("omits the filter graph entirely when the watermark is disabled", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    fakeChild();

    await startAndSettle(api, { watermark: false });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("-filter_complex");
  });

  it("fails the start when ffmpeg is not installed", async () => {
    const api = await makeSession(iosDevice);
    mockResolveFfmpeg.mockResolvedValue(null);

    try {
      await startAndSettle(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_FFMPEG_NOT_FOUND
      );
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(getActiveScreenRecordings()).toHaveLength(0);
    expect(api.startPending).toBe(false);
  });

  it("fails the start (and closes the stream) when no frame ever arrives", async () => {
    const api = await makeSession(iosDevice);
    const streamError = new Error("no frame");
    const stream = fakeStream({
      waitForFirstFrame: vi.fn(async () => {
        throw streamError;
      }),
    });

    await expect(startAndSettle(api)).rejects.toThrow("no frame");
    expect(stream.close).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(api.recordingActive).toBe(false);
  });

  it("fails the start when ffmpeg dies inside the fail-fast grace", async () => {
    const api = await makeSession(iosDevice);
    const stream = fakeStream();
    const child = fakeChild();

    const promise = startCapture(api, {
      streamUrl: STREAM_URL,
      timeLimitSeconds: 30,
      watermark: false,
    });
    await vi.advanceTimersByTimeAsync(1);
    child.stderr.emit("data", Buffer.from("Unrecognized option 'bogus'\n"));
    child.exit(1);

    try {
      await promise;
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_START_EXITED);
      expect((err as Error).message).toContain("Unrecognized option");
    }
    expect(stream.close).toHaveBeenCalled();
    expect(api.recordingActive).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("rejects a second start while a recording is active", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    fakeChild();
    await startAndSettle(api);

    fakeStream();
    fakeChild();
    try {
      await startAndSettle(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE);
    }
  });

  it("rejects a start that overlaps another start's readiness window", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    fakeChild();
    const first = startCapture(api, {
      streamUrl: STREAM_URL,
      timeLimitSeconds: 30,
      watermark: false,
    });

    // Second start lands while the first is still inside its grace.
    await expect(
      startCapture(api, { streamUrl: STREAM_URL, timeLimitSeconds: 30, watermark: false })
    ).rejects.toThrow(/already in flight|already running/i);

    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    await first;
  });

  it("rejects a stop while a start is still in flight on the session", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    fakeChild();
    const first = startCapture(api, {
      streamUrl: STREAM_URL,
      timeLimitSeconds: 30,
      watermark: false,
    });

    try {
      await stopCapture(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE);
    }

    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    await first;
  });

  it("a superseded capture's exit no longer touches the new capture's session", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const first = fakeChild();
    await startAndSettle(api);

    // Simulate the first capture ending and being stopped, then a fresh start.
    first.exitOnStdinEnd();
    await fs.writeFile(api.outputFile!, Buffer.alloc(16, 1));
    const firstOutput = api.outputFile!;
    await stopCapture(api);
    await fs.rm(firstOutput, { force: true });

    fakeStream();
    const second = fakeChild();
    await startAndSettle(api);
    const secondOutput = api.outputFile;

    first.exit(0);

    expect(api.recordingActive).toBe(true);
    expect(api.captureProcess).toBe(second as unknown as ChildProcess);
    expect(api.outputFile).toBe(secondOutput);
  });

  it("aborts a start (no spawn) once the session has been disposed", async () => {
    const instance = await screenRecordingSessionBlueprint.factory({}, iosDevice, {
      device: iosDevice,
    } as never);
    const api = instance.api;
    api.disposed = true;
    const stream = fakeStream();

    try {
      await startAndSettle(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
      );
    }
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalled();
  });
});

describe("frame pump", () => {
  it("tops the encoder up to the frame count the elapsed time calls for", () => {
    expect(framesDue(1_000, 1_000)).toBe(0);
    expect(framesDue(1_000, 1_033)).toBe(0);
    expect(framesDue(1_000, 1_034)).toBe(1);
    expect(framesDue(1_000, 2_000)).toBe(30);
  });

  it("keeps re-emitting the last frame while the screen is static", async () => {
    const api = await makeSession(iosDevice);
    // A still screen produces exactly one frame and then nothing.
    const stream = fakeStream({ frameCount: 1 });
    const child = fakeChild();
    await startAndSettle(api);
    child.stdin.writes.length = 0;

    await vi.advanceTimersByTimeAsync(1_000);

    // ~1s of a 30fps timeline, all duplicates of the one frame we ever saw.
    expect(child.stdin.writes.length).toBeGreaterThanOrEqual(25);
    expect(child.stdin.writes.every((w) => w.equals(stream.latest!))).toBe(true);
  });

  it("writes newly arrived frames once the device draws again", async () => {
    const api = await makeSession(iosDevice);
    const stream = fakeStream();
    const child = fakeChild();
    await startAndSettle(api);
    child.stdin.writes.length = 0;

    const nextFrame = fakeJpeg(640, 480);
    stream.latest = nextFrame;
    await vi.advanceTimersByTimeAsync(200);

    expect(child.stdin.writes.at(-1)!.equals(nextFrame)).toBe(true);
  });

  it("skips ticks while ffmpeg's pipe is backed up instead of buffering in Node", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();
    await startAndSettle(api);
    child.stdin.writes.length = 0;
    child.stdin.writableLength = 64 * 1024 * 1024; // encoder is far behind

    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.stdin.writes).toHaveLength(0);
  });

  it("stops writing once the capture has been stopped", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api);
    await fs.writeFile(api.outputFile!, Buffer.alloc(32, 1));
    const outputFile = api.outputFile!;

    await stopCapture(api);
    const writesAtStop = child.stdin.writes.length;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.stdin.writes).toHaveLength(writesAtStop);
    await fs.rm(outputFile, { force: true });
  });
});

describe("screen recording stop", () => {
  it("finalizes the file, clears the session state and clears the reminder", async () => {
    const api = await makeSession(androidDevice);
    const stream = fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api);
    await fs.writeFile(api.outputFile!, Buffer.alloc(1024, 1));
    const outputFile = api.outputFile!;

    const result = await stopCapture(api);

    expect(result.outputFile).toBe(outputFile);
    expect(result.sizeBytes).toBe(1024);
    expect(result.durationMs).not.toBeNull();
    expect(result.warning).toBeUndefined();
    expect(child.stdin.ended).toBe(true);
    expect(stream.close).toHaveBeenCalled();
    expect(api.recordingActive).toBe(false);
    expect(api.outputFile).toBeNull();
    expect(api.pumpTimer).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);

    await fs.rm(outputFile, { force: true });
  });

  it("stop with no session fails with SCREEN_RECORDING_NO_ACTIVE_SESSION", async () => {
    const api = await makeSession(iosDevice);
    try {
      await stopCapture(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_NO_ACTIVE_SESSION
      );
    }
  });

  it("ends the capture at the time-limit cap and flips the reminder to finalized", async () => {
    const api = await makeSession(iosDevice);
    const stream = fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api, { timeLimitSeconds: 5 });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(child.stdin.ended).toBe(true);
    expect(stream.close).toHaveBeenCalled();
    expect(api.recordingActive).toBe(false);
    expect(api.recordingTimedOut).toBe(true);
    expect(api.pendingRetrieval).toBe(true);
    const [reminder] = getActiveScreenRecordings();
    expect(reminder?.finalizedReason).toContain("5s time limit");
  });

  it("durationMs reflects the capture length, not the idle time after the cap", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api, { timeLimitSeconds: 5 });

    await vi.advanceTimersByTimeAsync(5_000); // cap fires
    await vi.advanceTimersByTimeAsync(30_000); // agent notices much later
    await fs.writeFile(api.outputFile!, Buffer.alloc(64, 1));
    const outputFile = api.outputFile!;

    const result = await stopCapture(api);

    expect(result.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(result.durationMs).toBeLessThan(6_000);
    expect(result.warning).toContain("time limit");
    await fs.rm(outputFile, { force: true });
  });

  it("recovers the video when ffmpeg died before stop, with a warning", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();
    await startAndSettle(api);
    await fs.writeFile(api.outputFile!, Buffer.alloc(128, 1));
    const outputFile = api.outputFile!;

    child.exit(1); // encoder crashed mid-capture
    expect(api.pendingRetrieval).toBe(true);
    expect(api.recordingExitedUnexpectedly).toBe(true);

    const result = await stopCapture(api);

    expect(result.outputFile).toBe(outputFile);
    expect(result.warning).toContain("exited before stop");
    expect(getActiveScreenRecordings()).toHaveLength(0);
    await fs.rm(outputFile, { force: true });
  });

  it("warns when the frame stream dropped during the recording", async () => {
    const api = await makeSession(iosDevice);
    const stream = fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api);
    await fs.writeFile(api.outputFile!, Buffer.alloc(64, 1));
    const outputFile = api.outputFile!;
    stream.error = new Error("frame stream aborted");

    const result = await stopCapture(api);

    expect(result.warning).toContain("frame stream");
    await fs.rm(outputFile, { force: true });
  });

  it("stop fails loudly when the recording left no file behind", async () => {
    const api = await makeSession(iosDevice);
    fakeStream();
    const child = fakeChild();
    child.exitOnStdinEnd();
    await startAndSettle(api);

    try {
      await stopCapture(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING);
    }
    // The session must still be startable after a failed stop.
    expect(api.recordingActive).toBe(false);
    expect(api.stopPending).toBe(false);
  });
});

describe("readJpegDimensions", () => {
  it("reads the frame size from the SOF marker", () => {
    expect(readJpegDimensions(fakeJpeg(1320, 2868))).toEqual({ width: 1320, height: 2868 });
    expect(readJpegDimensions(fakeJpeg(1080, 2220))).toEqual({ width: 1080, height: 2220 });
  });

  it("skips leading segments before the SOF", () => {
    const app0 = Buffer.alloc(20);
    app0.writeUInt16BE(0xffd8, 0);
    app0.writeUInt16BE(0xffe0, 2); // APP0
    app0.writeUInt16BE(16, 4); // segment length, skipped over
    const jpeg = Buffer.concat([app0.subarray(0, 20), fakeJpeg(800, 600).subarray(2)]);
    expect(readJpegDimensions(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it("returns null when there is no frame header", () => {
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
