import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { PNG } from "pngjs";
import type { DeviceInfo } from "@argent/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenRecordingSessionBlueprint } from "../src/blueprints/screen-recording-session";
import { startDebugCapture } from "../src/tools/screen-recording/debug-capture";
import { ffmpegArgs, startCapture, stopCapture } from "../src/tools/screen-recording/capture";
import * as mjpegStreams from "../src/tools/screen-recording/mjpeg-stream";
import type { MjpegStream } from "../src/tools/screen-recording/mjpeg-stream";

function source(initial: Buffer) {
  let listener: ((frame: Buffer, receivedAtMs: number) => void) | null = null;
  const stream: MjpegStream = {
    latest: initial,
    frameCount: 1,
    error: null,
    waitForFirstFrame: async () => initial,
    close() {},
    subscribe(next) {
      listener = next;
      next(initial, 1_000);
      return () => {
        listener = null;
      };
    },
  };
  return { stream, emit: (frame: Buffer, atMs: number) => listener?.(frame, atMs) };
}

let scratch = "";
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "argent-debug-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("debug frame delivery", () => {
  it("retains arrivals between 30 Hz ticks and orders coalesced arrivals", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const writes: Buffer[] = [];
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, done) {
        writes.push(chunk);
        done();
      },
    });
    const input = source(Buffer.from("first"));
    const capture = startDebugCapture(stdin, scratch, vi.fn());
    capture.attach(input.stream);
    input.emit(Buffer.from("gap"), 1_016.667);
    input.emit(Buffer.from("target"), 1_025);
    input.emit(Buffer.from("coalesced"), 1_025);
    now.mockReturnValue(2_000);
    await capture.finish();
    input.emit(Buffer.from("after stop"), 2_001);
    await capture.finish();
    expect(capture.frameTimesUs).toEqual([0, 16_667, 25_000, 25_001, 1_000_000]);
    expect(writes).toHaveLength(1);
    expect(writes[0].toString()).toContain("duration 0.016667");
  });

  it("ends with a warning instead of silently skipping frames when JPEG writes fall behind", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const stdin = new Writable({ write() {} });
    const input = source(Buffer.alloc(1_024 * 1_024));
    const ended = vi.fn();
    const capture = startDebugCapture(stdin, scratch, ended);
    capture.attach(input.stream);
    for (let i = 0; i < 40; i++) input.emit(input.stream.latest!, 1_000 + i);
    await capture.finish();
    expect(ended).toHaveBeenCalledOnce();
    expect(capture.warning).toContain("could not keep up");
    expect(capture.frameTimesUs.length - 1).toBeLessThan(40);
    stdin.destroy();
  });
});

const hasEncoder =
  spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes(
    "libx264"
  ) && spawnSync("ffprobe", ["-version"]).status === 0;

function jpeg(rgb: number[], width = 33, height = 31): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([...rgb, 255], i);
  }
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "-",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-",
    ],
    { input: PNG.sync.write(png) }
  );
  expect(result.status, result.stderr?.toString()).toBe(0);
  return result.stdout;
}

it.skipIf(!hasEncoder)(
  "retains a 120 Hz flicker and arrival times across changing frame sizes in a real MP4",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "argent-debug-test-"));
    try {
      const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const file = path.join(dir, "debug.mp4");
      const first = jpeg([255, 0, 0]);
      const gap = jpeg([255, 255, 255]);
      const target = jpeg([0, 0, 255]);
      const resized = jpeg([0, 0, 255], 31, 33);
      const child = spawn(
        "ffmpeg",
        ffmpegArgs({
          outputFile: file,
          logoFile: null,
          graph: null,
          canvas: { width: 33, height: 31 },
          mode: "debug",
        })
      );
      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      const input = source(first);
      const capture = startDebugCapture(child.stdin, dir, vi.fn());
      capture.attach(input.stream);
      for (let i = 1; i < 120; i++) {
        const frame = i >= 80 && i < 100 ? resized : target;
        input.emit(i === 62 ? gap : frame, 1_000 + (i * 1_000) / 120);
      }
      now.mockReturnValue(2_000);
      await capture.finish();
      expect(await exit, stderr).toBe(0);
      const probe = spawnSync(
        "ffprobe",
        ["-v", "error", "-show_frames", "-show_streams", "-of", "json", file],
        { encoding: "utf8" }
      );
      expect(probe.status, probe.stderr).toBe(0);
      const result = JSON.parse(probe.stdout) as {
        frames: { pts_time: string }[];
        streams: { width: number; height: number; time_base: string; pix_fmt: string }[];
      };
      expect(result.frames.map((frame) => Math.round(Number(frame.pts_time) * 1_000_000))).toEqual([
        ...Array.from({ length: 120 }, (_, i) => Math.round((i * 1_000_000) / 120)),
        1_000_000,
      ]);
      expect(result.streams[0]).toMatchObject({
        width: 34,
        height: 32,
        time_base: "1/1000000",
      });
      expect(["yuv420p", "yuvj420p"]).toContain(result.streams[0].pix_fmt);
      expect(result.streams[0]).not.toHaveProperty("profile", "High 4:4:4 Predictive");
      const raw = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-fps_mode",
          "passthrough",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ],
        { maxBuffer: 1_000_000 }
      );
      expect(raw.status, raw.stderr.toString()).toBe(0);
      const frameBytes = 34 * 32 * 3;
      const pixel = [...raw.stdout.subarray(frameBytes * 62, frameBytes * 62 + 3)];
      expect(pixel.every((channel) => channel > 240)).toBe(true);
      expect((await readFile(file)).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000
);

it.skipIf(!hasEncoder)(
  "reports corrupt JPEG decoding as an incomplete recording",
  async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const input = source(jpeg([255, 0, 0]));
    vi.spyOn(mjpegStreams, "openMjpegStream").mockResolvedValue(input.stream);
    const device = {
      id: "debug-corrupt-fixture",
      platform: "ios",
      kind: "simulator",
    } as DeviceInfo;
    const instance = await screenRecordingSessionBlueprint.factory({}, device, { device } as never);
    let output: string | null = null;
    try {
      await startCapture(instance.api, {
        streamUrl: "http://unused.invalid",
        timeLimitSeconds: 10,
        watermark: false,
        trimStatic: false,
        mode: "debug",
      });
      output = instance.api.outputFile;
      input.emit(jpeg([255, 255, 255]), 1_016.667);
      input.emit(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 1_025);
      input.emit(jpeg([0, 0, 255]), 1_050);
      now.mockReturnValue(2_000);
      const result = await stopCapture(instance.api);
      expect(result.encodingComplete).toBe(false);
      expect(result.durationMs).toBeNull();
      expect(result.warning).toContain("Encoder stderr:");
    } finally {
      await instance.dispose();
      if (output) await rm(output, { force: true });
    }
  },
  20_000
);
