import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { DeviceInfo } from "@argent/registry";
import type { ChildProcess } from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock("../src/tools/screen-recording/mjpeg-stream", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/tools/screen-recording/mjpeg-stream")>();
  return { ...actual, openMjpegStream: vi.fn() };
});
vi.mock("../src/tools/screen-recording/watermark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/screen-recording/watermark")>();
  return {
    ...actual,
    buildWatermarkGraph: vi.fn(actual.buildWatermarkGraph),
    resolveFfmpeg: vi.fn(async () => "/fake/ffmpeg"),
    writeLogoTemp: vi.fn(async () => "/tmp/fake-logo.png"),
  };
});

const resolveLivePanelMock = vi.fn<(udid: string) => Promise<LivePanel>>();
vi.mock("../src/utils/foldable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/foldable")>()),
  resolveLivePanel: (udid: string) => resolveLivePanelMock(udid),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

import { spawn } from "child_process";
import type { Registry } from "@argent/registry";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import { startCapture, stopCapture, type PanelFollow } from "../src/tools/screen-recording/capture";
import type { LivePanel } from "../src/utils/foldable";
import { openMjpegStream } from "../src/tools/screen-recording/mjpeg-stream";
import { buildWatermarkGraph } from "../src/tools/screen-recording/watermark";
import { __resetActiveScreenRecordingsForTesting } from "../src/utils/screen-recording-reminder";
import { __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";
import { redirectTmpdir } from "./helpers/tmpdir-env";

const mockSpawn = vi.mocked(spawn);
const mockOpenStream = vi.mocked(openMjpegStream);

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const PANELS = [
  { screenId: 1, width: 1398, height: 2034 },
  { screenId: 3, width: 2007, height: 2853 },
];
const BASE_URL = "http://127.0.0.1:61830/stream.mjpeg";
const READY_GRACE_MS = 800;
const PANEL_POLL_MS = 1_000;

/** Minimal JPEG: SOI + SOF0 declaring the frame size + EOI. */
function fakeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffd8, 0);
  sof.writeUInt16BE(0xffc0, 2);
  sof.writeUInt16BE(17, 4);
  sof.writeUInt8(8, 6);
  sof.writeUInt16BE(height, 7);
  sof.writeUInt16BE(width, 9);
  sof.writeUInt16BE(0xffd9, 17);
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
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  exitOnStdinEnd(code = 0): void {
    this.stdin.end.mockImplementation(() => {
      this.stdin.ended = true;
      this.stdin.writable = false;
      queueMicrotask(() => this.exit(code));
    });
  }
}

interface FakeStream {
  url: string;
  latest: Buffer | null;
  frameCount: number;
  error: Error | null;
  waitForFirstFrame: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** One stream per open, keyed by the URL it was opened with. */
const opened: FakeStream[] = [];
function serveStreams(frameFor: (url: string) => Buffer | Error): void {
  mockOpenStream.mockImplementation(async (url: string) => {
    const frame = frameFor(url);
    if (frame instanceof Error) throw frame;
    const stream: FakeStream = {
      url,
      latest: frame,
      frameCount: 1,
      error: null,
      waitForFirstFrame: vi.fn(async () => frame),
      close: vi.fn(),
    };
    opened.push(stream);
    return stream as never;
  });
}

function fakeChild(): FakeChild {
  const child = new FakeChild();
  child.exitOnStdinEnd();
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
  return child;
}

/** The fake ffmpeg writes nothing; stop stats the file, so give it one. */
async function stop(api: ScreenRecordingSessionApi) {
  await fs.writeFile(api.outputFile!, "mp4");
  return stopCapture(api);
}

async function makeSession(): Promise<ScreenRecordingSessionApi> {
  const device: DeviceInfo = { id: DUO, platform: "ios", kind: "simulator" } as DeviceInfo;
  const instance = await screenRecordingSessionBlueprint.factory({}, device, { device } as never);
  return instance.api;
}

const COVER = fakeJpeg(1398, 2034);
const INNER = fakeJpeg(2007, 2853);

let restoreTmpdir: () => void = () => {};
let scratch = "";

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-follow-panel-test-"));
  restoreTmpdir = redirectTmpdir(scratch);
  __resetActiveScreenRecordingsForTesting();
  __resetReapedSessionsForTesting();
  mockSpawn.mockReset();
  mockOpenStream.mockReset();
  opened.length = 0;
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  restoreTmpdir();
  await fs.rm(scratch, { recursive: true, force: true });
});

const live = (screen: number): LivePanel => ({ screen, source: "ax-service" });
const UNKNOWN: LivePanel = { screen: 1, source: "unknown", reason: "nothing answered" };

async function startFollowing(
  api: ScreenRecordingSessionApi,
  resolveLivePanel: PanelFollow["resolveLivePanel"],
  initial: LivePanel = live(1)
) {
  const follow: PanelFollow = {
    initial,
    streamUrlForScreen: (screen) => (screen === 1 ? BASE_URL : `${BASE_URL}?screen=${screen}`),
    resolveLivePanel,
  };
  const promise = startCapture(api, {
    streamUrl: follow.streamUrlForScreen(initial.screen),
    timeLimitSeconds: 60,
    watermark: false,
    trimStatic: false,
    followPanel: follow,
  });
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
  return promise;
}

describe("a recording of a foldable follows the live panel", () => {
  it("moves the frame source to the other panel's stream and keeps one ffmpeg", async () => {
    serveStreams((url) => (url.includes("screen=3") ? INNER : COVER));
    const child = fakeChild();
    const api = await makeSession();
    let screen = 1;
    const resolve = vi.fn(async () => live(screen));
    await startFollowing(api, resolve);

    expect(opened.map((s) => s.url)).toEqual([BASE_URL]);
    expect(api.activeScreen).toBe(1);

    // The device unfolds; the next poll sees it.
    screen = 3;
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(opened.map((s) => s.url)).toEqual([BASE_URL, `${BASE_URL}?screen=3`]);
    expect(api.activeScreen).toBe(3);
    expect(api.panelSwitches).toBe(1);
    expect(api.frameStream).toBe(opened[1]);
    // The old stream is released only once the new one has a frame.
    expect(opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(opened[1]!.close).not.toHaveBeenCalled();
    // ffmpeg was spawned once: the pump keeps feeding the same process.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Frames written after the switch are the inner panel's.
    const before = child.stdin.writes.length;
    await vi.advanceTimersByTimeAsync(200);
    const after = child.stdin.writes.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => f.equals(INNER))).toBe(true);

    // Folding back counts a second switch, onto a fresh cover stream.
    screen = 1;
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.panelSwitches).toBe(2);
    expect(opened).toHaveLength(3);

    const stopped = await stop(api);
    expect(stopped.panelSwitches).toBe(2);
    expect(api.panelPollTimer).toBeNull();
  });

  it("stays on the current stream when the other panel's stream cannot be opened, and retries", async () => {
    let fail = true;
    serveStreams((url) =>
      url.includes("screen=3") ? (fail ? new Error("connect refused") : INNER) : COVER
    );
    fakeChild();
    const api = await makeSession();
    await startFollowing(api, async () => live(3));

    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.activeScreen).toBe(1);
    expect(api.frameStream).toBe(opened[0]);
    expect(opened[0]!.close).not.toHaveBeenCalled();

    fail = false;
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.activeScreen).toBe(3);
    expect(api.panelSwitches).toBe(1);
    await stop(api);
  });

  it("stays put when nothing resolves the panel, and says so at stop", async () => {
    serveStreams((url) => (url.includes("screen=3") ? INNER : COVER));
    fakeChild();
    const api = await makeSession();
    let answer: LivePanel = UNKNOWN;
    await startFollowing(api, async () => answer, live(3));
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 3);
    // An unresolved panel is not the main screen: the capture stays where it is.
    expect(opened).toHaveLength(1);
    expect(api.activeScreen).toBe(3);
    expect(api.panelSwitches).toBe(0);
    // A source answering again moves it, as any change does.
    answer = live(1);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.activeScreen).toBe(1);
    const stopped = await stop(api);
    expect(stopped.panelSwitches).toBe(1);
    expect(stopped.warning).toContain("could not be resolved 3 time(s) during the recording");
    expect(stopped.warning).toContain("neither the accessibility service nor CoreDevice answered");
  });

  it("warns at start when nothing resolved the panel, through the tool", async () => {
    serveStreams(() => COVER);
    fakeChild();
    const api = await makeSession();
    resolveLivePanelMock.mockResolvedValue(UNKNOWN);
    const registry = {
      resolveService: vi.fn(async () => ({
        apiUrl: "http://127.0.0.1:61830",
        streamUrl: BASE_URL,
        deviceId: DUO,
        display: { foldable: true, panels: PANELS, hingeAngle: null },
      })),
    } as unknown as Registry;
    const tool = createScreenRecordingStartTool(registry);
    const start = tool.execute(
      { session: api },
      { udid: DUO, showTouches: false, trimStatic: false, timeLimitSeconds: 60 }
    );
    start.catch(() => {});
    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    const started = await start;
    expect(started.status).toBe("recording");
    expect(started.warning).toContain("could not be resolved (nothing answered)");
    expect(started.warning).toContain("the recording started on screen 1 (cover panel, 1398x2034)");
    expect(api.panelReadFailures).toBe(1);
    await stop(api);

    // Resolved: the same start carries no warning.
    resolveLivePanelMock.mockResolvedValue(live(3));
    serveStreams(() => INNER);
    fakeChild();
    const resolved = tool.execute(
      { session: api },
      { udid: DUO, showTouches: false, trimStatic: false, timeLimitSeconds: 60 }
    );
    resolved.catch(() => {});
    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    expect(await resolved).not.toHaveProperty("warning");
    expect(api.activeScreen).toBe(3);
    await stop(api);
  });

  it("counts a start that resolved nothing with the checks that failed", async () => {
    serveStreams(() => COVER);
    fakeChild();
    const api = await makeSession();
    await startFollowing(api, async () => UNKNOWN, UNKNOWN);
    expect(api.activeScreen).toBe(1);
    expect(api.panelReadFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 2);
    const stopped = await stop(api);
    expect(stopped.warning).toContain("could not be resolved 3 time(s) during the recording");
    expect(stopped.warning).toContain("at its start, and on its checks every second");
  });

  it("warns about nothing while every panel check is answered", async () => {
    serveStreams(() => COVER);
    fakeChild();
    const api = await makeSession();
    await startFollowing(api, async () => live(1));
    await vi.advanceTimersByTimeAsync(PANEL_POLL_MS * 3);
    const stopped = await stop(api);
    expect(stopped).not.toHaveProperty("warning");
  });

  it("polls nothing for a device with one panel", async () => {
    serveStreams(() => COVER);
    fakeChild();
    const api = await makeSession();
    const promise = startCapture(api, {
      streamUrl: BASE_URL,
      timeLimitSeconds: 60,
      watermark: false,
      trimStatic: false,
    });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    await promise;
    expect(api.panelPollTimer).toBeNull();
    expect(api.activeScreen).toBeNull();
    await stop(api);
  });

  it("pins the watermark base only when following a panel", async () => {
    const graph = vi.mocked(buildWatermarkGraph);
    graph.mockClear();
    serveStreams(() => INNER);
    fakeChild();
    const following = await makeSession();
    const follow: PanelFollow = {
      initial: live(3),
      streamUrlForScreen: (screen) => `${BASE_URL}?screen=${screen}`,
      resolveLivePanel: async () => live(3),
    };
    const start = startCapture(following, {
      streamUrl: follow.streamUrlForScreen(3),
      timeLimitSeconds: 60,
      watermark: true,
      trimStatic: false,
      followPanel: follow,
    });
    start.catch(() => {});
    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    await start;
    expect(graph).toHaveBeenCalledWith({ width: 2007, height: 2853 }, { pinSize: true });
    await stop(following);

    graph.mockClear();
    fakeChild();
    const plain = await makeSession();
    const plainStart = startCapture(plain, {
      streamUrl: BASE_URL,
      timeLimitSeconds: 60,
      watermark: true,
      trimStatic: false,
    });
    plainStart.catch(() => {});
    await vi.advanceTimersByTimeAsync(READY_GRACE_MS);
    await plainStart;
    expect(graph).toHaveBeenCalledWith({ width: 2007, height: 2853 }, { pinSize: false });
    await stop(plain);
  });
});
