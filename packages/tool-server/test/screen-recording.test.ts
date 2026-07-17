import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";
import type { ChildProcess } from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/fake/adb"),
}));
vi.mock("../src/utils/adb", () => ({
  adbShell: vi.fn(async () => ""),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

import { spawn } from "child_process";
import { adbShell, runAdb } from "../src/utils/adb";
import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import {
  startScreenRecordingIos,
  stopScreenRecordingIos,
} from "../src/tools/screen-recording/platforms/ios";
import {
  startScreenRecordingAndroid,
  stopScreenRecordingAndroid,
} from "../src/tools/screen-recording/platforms/android";
import {
  __resetActiveScreenRecordingsForTesting,
  getActiveScreenRecordings,
} from "../src/utils/screen-recording-reminder";

const mockSpawn = vi.mocked(spawn);
const mockAdbShell = vi.mocked(adbShell);
const mockRunAdb = vi.mocked(runAdb);

const IOS_UDID = "6DBF83B4-0000-0000-0000-000000000000";
const ANDROID_SERIAL = "emulator-5554";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  /** Simulate the process ending: stamps exitCode/signalCode, emits 'exit'. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
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

const iosDevice: DeviceInfo = { id: IOS_UDID, platform: "ios", kind: "simulator" } as DeviceInfo;
const androidDevice: DeviceInfo = {
  id: ANDROID_SERIAL,
  platform: "android",
  kind: "emulator",
} as DeviceInfo;

beforeEach(() => {
  __resetActiveScreenRecordingsForTesting();
  mockSpawn.mockReset();
  mockAdbShell.mockReset();
  mockAdbShell.mockResolvedValue("");
  mockRunAdb.mockReset();
  mockRunAdb.mockResolvedValue({ stdout: "", stderr: "" });
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
});

describe("iOS screen recording", () => {
  it("starts recordVideo, stamps the session, and registers the reminder", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();

    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    const result = await startPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["simctl", "io", IOS_UDID, "recordVideo", "--codec=h264", "--force"]),
      expect.anything()
    );
    expect(result.status).toBe("recording");
    expect(result.outputFile).toMatch(/argent-screen-recording-.*\.mp4$/);
    expect(api.recordingActive).toBe(true);
    expect(api.outputFile).toBe(result.outputFile);

    const reminders = getActiveScreenRecordings();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      deviceId: IOS_UDID,
      status: "recording",
      timeLimitSeconds: 180,
    });

    // cleanup the pending cap timer
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("fails the start (and registers no reminder) when recordVideo exits early", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();

    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    const assertion = expect(startPromise).rejects.toSatisfy((err: unknown) => {
      return (
        getFailureSignal(err)?.error_code === FAILURE_CODES.SCREEN_RECORDING_START_EXITED &&
        String(err).includes("Invalid device")
      );
    });
    child.stderr.emit("data", Buffer.from("Invalid device: nope\n"));
    child.exit(1);
    await assertion;

    expect(api.recordingActive).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("rejects a second start while a recording is active", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();
    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    await startPromise;

    try {
      await startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE);
    }

    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("SIGINTs the capture at the time-limit cap and flips the reminder to finalized", async () => {
    vi.useFakeTimers();
    const api = await makeSession(iosDevice);
    const child = fakeChild();

    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 5 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    await vi.advanceTimersByTimeAsync(200);
    await startPromise;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(api.recordingActive).toBe(false);
    expect(api.recordingTimedOut).toBe(true);
    expect(getActiveScreenRecordings()[0]).toMatchObject({
      status: "finalized",
      finalizedReason: expect.stringContaining("time limit"),
    });
  });

  it("stop finalizes the file, clears the session state, and clears the reminder", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();
    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    await startPromise;

    // recordVideo "wrote" the file; SIGINT finalizes and the child exits.
    await fs.writeFile(api.outputFile!, Buffer.alloc(1024, 1));
    const outputFile = api.outputFile!;
    child.kill.mockImplementation((signal?: NodeJS.Signals) => {
      if (signal === "SIGINT") queueMicrotask(() => child.exit(0));
      return true;
    });

    const result = await stopScreenRecordingIos(api);

    expect(result.outputFile).toBe(outputFile);
    expect(result.sizeBytes).toBe(1024);
    expect(result.durationMs).not.toBeNull();
    expect(result.warning).toBeUndefined();
    expect(api.recordingActive).toBe(false);
    expect(api.outputFile).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);

    await fs.rm(outputFile, { force: true });
  });

  it("stop with no session fails with SCREEN_RECORDING_NO_ACTIVE_SESSION", async () => {
    const api = await makeSession(iosDevice);
    try {
      await stopScreenRecordingIos(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_NO_ACTIVE_SESSION
      );
    }
  });

  it("recovers the video when recordVideo died before stop, with a warning", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();
    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    await startPromise;

    const outputFile = api.outputFile!;
    await fs.writeFile(outputFile, Buffer.alloc(64, 1));
    child.exit(1); // simulator shut down mid-capture

    expect(api.recordingExitedUnexpectedly).toBe(true);
    expect(getActiveScreenRecordings()[0]?.status).toBe("finalized");

    const result = await stopScreenRecordingIos(api);
    expect(result.warning).toContain("exited before stop");
    expect(getActiveScreenRecordings()).toHaveLength(0);

    await fs.rm(outputFile, { force: true });
  });

  it("stop fails loudly when the recording left no file behind", async () => {
    const api = await makeSession(iosDevice);
    const child = fakeChild();
    const startPromise = startScreenRecordingIos(api, { udid: IOS_UDID, timeLimitSeconds: 180 });
    child.stderr.emit("data", Buffer.from("Recording started.\n"));
    await startPromise;
    child.kill.mockImplementation((signal?: NodeJS.Signals) => {
      if (signal === "SIGINT") queueMicrotask(() => child.exit(0));
      return true;
    });

    try {
      await stopScreenRecordingIos(api);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING);
    }
    // A failed stop must still return the session to a startable state.
    expect(api.recordingActive).toBe(false);
    expect(api.outputFile).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });
});

describe("Android screen recording", () => {
  async function startAndroid(
    timeLimitSeconds: number
  ): Promise<{ api: ScreenRecordingSessionApi; child: FakeChild }> {
    const api = await makeSession(androidDevice);
    const child = fakeChild();
    vi.useFakeTimers();
    const startPromise = startScreenRecordingAndroid(api, {
      udid: ANDROID_SERIAL,
      timeLimitSeconds,
    });
    // Let the async resolveAndroidBinary hop complete so spawn has run and the
    // stdout listener is attached before READY is emitted.
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit("data", Buffer.from("READY:4321\n"));
    await vi.advanceTimersByTimeAsync(1_000); // fail-fast grace
    await startPromise;
    return { api, child };
  }

  it("starts screenrecord in the background with the PID echo and clamps the cap to 180s", async () => {
    const { api, child } = await startAndroid(600);

    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe("/fake/adb");
    expect(args).toEqual(["-s", ANDROID_SERIAL, "shell", expect.stringContaining("screenrecord")]);
    const shellCommand = (args as string[])[3]!;
    expect(shellCommand).toContain("--time-limit 180");
    expect(shellCommand).toContain('echo "READY:$!"');
    expect(shellCommand).toContain("wait $!");

    expect(api.timeLimitSeconds).toBe(180);
    expect(api.androidDevicePid).toBe(4321);
    expect(api.androidOnDeviceFile).toMatch(/^\/sdcard\/argent-screen-recording-\d+\.mp4$/);
    expect(getActiveScreenRecordings()[0]).toMatchObject({
      deviceId: ANDROID_SERIAL,
      timeLimitSeconds: 180,
    });

    child.exit(0);
  });

  it("ignores a split PID chunk until the line completes", async () => {
    const api = await makeSession(androidDevice);
    const child = fakeChild();
    vi.useFakeTimers();
    const startPromise = startScreenRecordingAndroid(api, {
      udid: ANDROID_SERIAL,
      timeLimitSeconds: 60,
    });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit("data", Buffer.from("READY:43"));
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.emit("data", Buffer.from("21\r\n"));
    await vi.advanceTimersByTimeAsync(1_000);
    await startPromise;
    expect(api.androidDevicePid).toBe(4321);
    child.exit(0);
  });

  it("fails the start when screenrecord dies right after the PID echo", async () => {
    const api = await makeSession(androidDevice);
    const child = fakeChild();
    vi.useFakeTimers();
    const startPromise = startScreenRecordingAndroid(api, {
      udid: ANDROID_SERIAL,
      timeLimitSeconds: 60,
    });
    const assertion = expect(startPromise).rejects.toSatisfy(
      (err: unknown) =>
        getFailureSignal(err)?.error_code === FAILURE_CODES.SCREEN_RECORDING_START_EXITED
    );
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit("data", Buffer.from("READY:4321\n"));
    child.stderr.emit("data", Buffer.from("screenrecord: unable to configure recorder\n"));
    child.exit(1);
    await assertion;

    expect(api.recordingActive).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("treats a clean self-exit as the time limit and keeps the retrieval reminder", async () => {
    const { api, child } = await startAndroid(60);

    child.exit(0); // screenrecord hit --time-limit and ended on its own

    expect(api.recordingActive).toBe(false);
    expect(api.recordingTimedOut).toBe(true);
    expect(getActiveScreenRecordings()[0]).toMatchObject({
      status: "finalized",
      finalizedReason: expect.stringContaining("time limit"),
    });
  });

  it("stop SIGINTs the device-side pid, pulls the file, and cleans up", async () => {
    const { api, child } = await startAndroid(60);
    vi.useRealTimers();

    const onDeviceFile = api.androidOnDeviceFile!;
    const outputFile = api.outputFile!;
    mockAdbShell.mockImplementation(async (_serial, command) => {
      if (command.startsWith("kill -INT")) child.exit(0);
      return "";
    });
    mockRunAdb.mockImplementation(async (args) => {
      if (args[2] === "pull") await fs.writeFile(args[4]!, Buffer.alloc(2048, 1));
      return { stdout: "", stderr: "" };
    });

    const result = await stopScreenRecordingAndroid(api);

    expect(mockAdbShell).toHaveBeenCalledWith(ANDROID_SERIAL, "kill -INT 4321", expect.anything());
    expect(mockRunAdb).toHaveBeenCalledWith(
      ["-s", ANDROID_SERIAL, "pull", onDeviceFile, outputFile],
      expect.anything()
    );
    expect(mockAdbShell).toHaveBeenCalledWith(
      ANDROID_SERIAL,
      `rm -f ${onDeviceFile}`,
      expect.anything()
    );
    expect(result.sizeBytes).toBe(2048);
    expect(result.warning).toBeUndefined();
    expect(api.recordingActive).toBe(false);
    expect(api.androidOnDeviceFile).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);

    await fs.rm(outputFile, { force: true });
  });

  it("stop after the time limit pulls the finished file with a warning", async () => {
    const { api, child } = await startAndroid(60);
    vi.useRealTimers();
    child.exit(0); // cap reached before stop was called

    const outputFile = api.outputFile!;
    mockRunAdb.mockImplementation(async (args) => {
      if (args[2] === "pull") await fs.writeFile(args[4]!, Buffer.alloc(128, 1));
      return { stdout: "", stderr: "" };
    });

    const result = await stopScreenRecordingAndroid(api);

    expect(result.warning).toContain("time limit");
    expect(result.sizeBytes).toBe(128);
    expect(getActiveScreenRecordings()).toHaveLength(0);

    await fs.rm(outputFile, { force: true });
  });

  it("a failed pull still returns the session to a startable state", async () => {
    const { api, child } = await startAndroid(60);
    vi.useRealTimers();
    mockAdbShell.mockImplementation(async (_serial, command) => {
      if (command.startsWith("kill -INT")) child.exit(0);
      return "";
    });
    mockRunAdb.mockRejectedValue(new Error("device offline"));

    await expect(stopScreenRecordingAndroid(api)).rejects.toThrow("device offline");
    expect(api.recordingActive).toBe(false);
    expect(api.androidDevicePid).toBeNull();
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });
});
