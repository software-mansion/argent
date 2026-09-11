import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";

vi.mock("../src/utils/sim-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/sim-remote")>();
  return { ...actual, screenRecordStart: vi.fn(), screenRecordStop: vi.fn() };
});
// The post-pass is exercised through its absence here (no ffmpeg -> the raw
// download is handed over with a warning); the graph itself has its own tests.
vi.mock("../src/tools/screen-recording/watermark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/screen-recording/watermark")>();
  return {
    ...actual,
    resolveFfmpeg: vi.fn(async () => null),
    resolveFfprobe: vi.fn(async () => null),
  };
});

import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import {
  startRemoteCapture,
  stopRemoteCapture,
} from "../src/tools/screen-recording/capture-remote";
import { screenRecordStart, screenRecordStop } from "../src/utils/sim-remote";
import {
  __resetActiveScreenRecordingsForTesting,
  getActiveScreenRecordings,
} from "../src/utils/screen-recording-reminder";
import { __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";
import { redirectTmpdir } from "./helpers/tmpdir-env";

const mockStart = vi.mocked(screenRecordStart);
const mockStop = vi.mocked(screenRecordStop);

const REMOTE_UDID = "remote:6DBF83B4-0000-0000-0000-000000000000";

const remoteDevice: DeviceInfo = {
  id: REMOTE_UDID,
  platform: "ios-remote",
  kind: "simulator",
} as DeviceInfo;

async function makeSession(): Promise<ScreenRecordingSessionApi> {
  // The payload argument is unused by this factory; options carry the device.
  const instance = await screenRecordingSessionBlueprint.factory({}, remoteDevice, {
    device: remoteDevice,
  } as never);
  return instance.api;
}

/** Make `screenRecordStop` produce a plausible mp4 at the path it is given. */
function stopWritesVideo(bytes = "mp4 bytes"): void {
  mockStop.mockImplementation(async (_udid: string, outputFile: string) => {
    await fs.writeFile(outputFile, bytes);
  });
}

describe("remote screen recording", () => {
  let tmpDir: string;
  let restoreTmpdir: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetActiveScreenRecordingsForTesting();
    __resetReapedSessionsForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-remote-recording-"));
    restoreTmpdir = redirectTmpdir(tmpDir);
    mockStart.mockResolvedValue(undefined);
    stopWritesVideo();
  });

  afterEach(async () => {
    restoreTmpdir();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records on the runner and hands the downloaded mp4 over at stop", async () => {
    const api = await makeSession();

    const started = await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: true,
    });

    expect(started.status).toBe("recording");
    expect(mockStart).toHaveBeenCalledWith(REMOTE_UDID, { showTouches: true });
    // The reminder has to point at the capture for its whole life, the same as
    // a local one — nothing else tells the agent a recording is still running.
    expect(getActiveScreenRecordings()).toHaveLength(1);

    const stopped = await stopRemoteCapture(api);
    expect(mockStop).toHaveBeenCalledWith(REMOTE_UDID, started.outputFile);
    expect(stopped.outputFile).toBe(started.outputFile);
    expect(stopped.sizeBytes).toBeGreaterThan(0);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("passes showTouches through, so the overlay is only drawn when asked for", async () => {
    const api = await makeSession();
    await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    });
    expect(mockStart).toHaveBeenCalledWith(REMOTE_UDID, { showTouches: false });
  });

  /**
   * A start that never reached the runner must leave the session startable, or
   * a retry is rejected as "already recording" against a recording that does
   * not exist.
   */
  it("leaves the session startable when the runner refuses the start", async () => {
    const api = await makeSession();
    mockStart.mockRejectedValueOnce(new Error("device is not booted"));

    const err = await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err as Error)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE
    );
    expect(api.recordingActive).toBe(false);
    expect(api.startPending).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);

    stopWritesVideo();
    await expect(
      startRemoteCapture(api, {
        timeLimitSeconds: 60,
        watermark: false,
        trimStatic: false,
        showTouches: false,
      })
    ).resolves.toMatchObject({ status: "recording" });
  });

  /**
   * The runner keeps recording until it is told to stop, so the cap has to
   * fetch there and then — waiting for the caller's stop would let the video
   * grow past the limit they set.
   */
  it("ends the recording on the runner when the time limit fires, not at stop", async () => {
    vi.useFakeTimers();
    try {
      const api = await makeSession();
      const started = await startRemoteCapture(api, {
        timeLimitSeconds: 5,
        watermark: false,
        trimStatic: false,
        showTouches: false,
      });

      expect(mockStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockStop).toHaveBeenCalledWith(REMOTE_UDID, started.outputFile);

      const stopped = await stopRemoteCapture(api);
      // Exactly once: the stop must not ask the runner to end a recording that
      // already ended.
      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(stopped.warning).toContain("time limit");
      expect(stopped.outputFile).toBe(started.outputFile);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ffmpeg did not produce this video, so a host without it still has a
   * complete recording to hand over — with the trim reported as skipped rather
   * than silently not applied.
   */
  it("returns the untrimmed recording with a warning when ffmpeg is missing", async () => {
    const api = await makeSession();
    await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: true,
      trimStatic: true,
      showTouches: false,
    });

    const stopped = await stopRemoteCapture(api);
    expect(stopped.sizeBytes).toBeGreaterThan(0);
    expect(stopped.warning).toContain("ffmpeg");
    expect(stopped.warning).toContain("dead air was not trimmed");
    expect(stopped.warning).toContain("the watermark was not applied");
    // Nothing was rewritten, so there is no trimmed length to report against.
    expect(stopped.trimmedMs).toBeUndefined();
  });

  it("fails the stop when the download brings back nothing", async () => {
    const api = await makeSession();
    await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    });
    mockStop.mockImplementation(async (_udid: string, outputFile: string) => {
      await fs.writeFile(outputFile, "");
    });

    const err = await stopRemoteCapture(api).catch((e: unknown) => e);
    expect(getFailureSignal(err as Error)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING
    );
    // Startable again: a failed handover must not wedge the next recording.
    expect(api.recordingActive).toBe(false);
    expect(api.stopPending).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("rejects a second start while one is already recording", async () => {
    const api = await makeSession();
    await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    });

    const err = await startRemoteCapture(api, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err as Error)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE
    );
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("rejects a stop with no recording to hand over", async () => {
    const api = await makeSession();
    const err = await stopRemoteCapture(api).catch((e: unknown) => e);
    expect(getFailureSignal(err as Error)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_NO_ACTIVE_SESSION
    );
  });

  /**
   * A teardown that just forgets the session would leave simulator-server
   * buffering frames on the runner for a video nobody can collect.
   */
  it("releases the runner-side recording when the session is torn down", async () => {
    const instance = await screenRecordingSessionBlueprint.factory({}, remoteDevice, {
      device: remoteDevice,
    } as never);
    const started = await startRemoteCapture(instance.api as ScreenRecordingSessionApi, {
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
      showTouches: false,
    });

    await instance.dispose?.();
    // Downloaded onto the path the start handed back, so the partial video is
    // where the teardown breadcrumb says it is.
    expect(mockStop).toHaveBeenCalledWith(REMOTE_UDID, started.outputFile);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });
});
