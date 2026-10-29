import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { PNG } from "pngjs";
import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenRecordingSessionBlueprint } from "../src/blueprints/screen-recording-session";
import { verifyDebugEncoder, verifyDebugVideo } from "../src/tools/screen-recording/encoder";
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
    for (let i = 0; i < 140; i++) input.emit(input.stream.latest!, 1_000 + i);
    await capture.finish();
    expect(ended).toHaveBeenCalledOnce();
    expect(capture.warning).toContain("could not keep up");
    expect(capture.frameTimesUs.length - 1).toBeLessThan(140);
    stdin.destroy();
  });
});

it("drains the JPEG backlog across more than its total byte budget", async () => {
  const stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const frame = Buffer.alloc(2 * 1024 * 1024);
  const input = source(frame);
  const ended = vi.fn();
  const capture = startDebugCapture(stdin, scratch, ended);
  capture.attach(input.stream);
  for (let i = 0; i < 80; i++) {
    input.emit(frame, performance.now());
    await vi.waitFor(async () => expect((await readdir(scratch)).length).toBe(i + 2), {
      interval: 1,
    });
  }
  await capture.finish();
  expect(ended).not.toHaveBeenCalled();
  expect(capture.frameTimesUs).toHaveLength(82);
  expect(capture.warning).toBeNull();
}, 20_000);

it("keeps writing other frames while one JPEG write stalls", async () => {
  const actual = fs.writeFile.bind(fs);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...args) => {
    if (String(file).endsWith("0.jpg")) await held;
    return actual(file, data, ...args);
  });
  const stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = source(Buffer.from("first"));
  const capture = startDebugCapture(stdin, scratch, vi.fn());
  capture.attach(input.stream);
  input.emit(Buffer.from("second"), performance.now());
  try {
    await vi.waitFor(async () =>
      expect(await readFile(path.join(scratch, "1.jpg"), "utf8")).toBe("second")
    );
  } finally {
    release();
    await capture.finish();
  }
  expect(capture.frameTimesUs).toHaveLength(3);
});

it("retains only the contiguous saved frames after a write failure", async () => {
  const actual = fs.writeFile.bind(fs);
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, ...args) => {
    if (String(file).endsWith("1.jpg")) throw new Error("disk full");
    return actual(file, data, ...args);
  });
  const stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = source(Buffer.from("first"));
  const ended = vi.fn();
  const capture = startDebugCapture(stdin, scratch, ended);
  capture.attach(input.stream);
  for (let i = 1; i < 10; i++) input.emit(Buffer.from(`${i}`), performance.now());
  await capture.finish();
  expect(ended).toHaveBeenCalledOnce();
  expect(capture.warning).toContain("disk full");
  expect(capture.frameTimesUs).toHaveLength(2);
  expect(fs.writeFile).toHaveBeenCalledTimes(4);
  await expect(readFile(path.join(scratch, "4.jpg"))).rejects.toThrow();
});

const hasEncoder =
  spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes(
    "libx264"
  ) && spawnSync("ffprobe", ["-version"]).status === 0;

if (process.env.CI && !hasEncoder) {
  throw new Error("Recording tests require ffmpeg with libx264 and ffprobe in CI.");
}

function jpeg(rgb: number[], width = 33, height = 31, pixFmt = "yuvj444p"): Buffer {
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
      "-pix_fmt",
      pixFmt,
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
        streams: {
          width: number;
          height: number;
          time_base: string;
          pix_fmt: string;
          level: number;
        }[];
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
      expect(result.streams[0].level).toBeLessThan(62);
      expect(stderr).not.toContain("MB rate");
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
      expect(raw.stdout.length / frameBytes).toBe(result.frames.length);
      const pixel = [...raw.stdout.subarray(frameBytes * 62, frameBytes * 62 + 3)];
      expect(pixel.every((channel) => channel > 240)).toBe(true);
      const bar = frameBytes * 80 + 16 * 34 * 3;
      expect([...raw.stdout.subarray(bar, bar + 3)].every((channel) => channel < 40)).toBe(true);
      const extraction = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-fps_mode",
          "passthrough",
          "-enc_time_base",
          "1:1000000",
          path.join(dir, "frame-%06d.png"),
        ],
        { encoding: "utf8" }
      );
      expect(extraction.status, extraction.stderr).toBe(0);
      expect(extraction.stderr).not.toContain("non monotonically");
      expect((await readdir(dir)).filter((name) => name.endsWith(".png"))).toHaveLength(
        result.frames.length
      );
      expect((await readFile(file)).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000
);

it.skipIf(!hasEncoder).each([false, true])(
  "reports debug duration and encoder status (corrupt: %s)",
  async (corrupt) => {
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
      if (corrupt) input.emit(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 1_025);
      input.emit(jpeg([0, 0, 255]), 1_050);
      now.mockReturnValue(2_000);
      const result = await stopCapture(instance.api);
      expect(result.encodingComplete).toBe(!corrupt);
      if (corrupt) {
        expect(result.durationMs).toBeNull();
        expect(result.warning).toContain("Encoder stderr:");
        const decoded = spawnSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          result.outputFile,
          "-fps_mode",
          "passthrough",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        expect(decoded.status, decoded.stderr.toString()).toBe(0);
        const frameBytes = 34 * 32 * 3;
        expect(decoded.stdout.length / frameBytes).toBe(4);
        const bluePixel = decoded.stdout.subarray(2 * frameBytes, 2 * frameBytes + 3);
        expect(bluePixel[2]).toBeGreaterThan(240);
        expect(bluePixel[0]).toBeLessThan(15);
      } else {
        const probe = spawnSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "json", result.outputFile],
          { encoding: "utf8" }
        );
        expect(probe.status, probe.stderr).toBe(0);
        const duration = Number(JSON.parse(probe.stdout).format.duration) * 1_000;
        expect(result.durationMs).toBe(1_000);
        expect(result.durationMs).toBe(Math.round(duration));
      }
    } finally {
      await instance.dispose();
      if (output) await rm(output, { force: true });
    }
  },
  20_000
);

it.skipIf(!hasEncoder || process.platform === "win32")(
  "surfaces a real encoder preflight failure",
  async () => {
    const wrapper = path.join(scratch, "unavailable-encoder");
    await fs.writeFile(
      wrapper,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[args.indexOf("-c:v") + 1] === "libx264") {\n  process.stderr.write("Unknown encoder libx264\\n"); process.exit(1);\n}\nprocess.exit(0);\n`,
      { mode: 0o755 }
    );
    await expect(verifyDebugEncoder(wrapper, jpeg([255, 0, 0]))).rejects.toThrow(
      "Unknown encoder libx264"
    );
  }
);

it.skipIf(!hasEncoder)(
  "keeps a phone-sized debug video within a playable H.264 level",
  async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const output = path.join(scratch, "phone.mp4");
    expect(
      ffmpegArgs({ mode: "debug", outputFile: output, logoFile: null, graph: null, canvas: null })
    ).not.toContain("+faststart");
    const child = spawn(
      "ffmpeg",
      ffmpegArgs({
        outputFile: output,
        logoFile: null,
        graph: null,
        canvas: { width: 390, height: 844 },
        mode: "debug",
      })
    );
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const capture = startDebugCapture(child.stdin, scratch, vi.fn());
    capture.attach(source(jpeg([0, 0, 255], 390, 844)).stream);
    now.mockReturnValue(2_000);
    await capture.finish();
    expect(await closed, stderr).toBe(0);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=level,width,height", "-of", "json", output],
      { encoding: "utf8" }
    );
    expect(probe.status, probe.stderr).toBe(0);
    const stream = JSON.parse(probe.stdout).streams[0];
    expect(stream).toMatchObject({ width: 390, height: 844 });
    expect(stream.level).toBeLessThan(62);
    expect(stderr).not.toContain("MB rate");
  }
);

it("retains a 64 MiB write backlog while all write lanes are stalled", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs, "writeFile").mockImplementation(async () => {
    await held;
  });
  const stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = source(Buffer.alloc(8 * 1024 * 1024));
  const ended = vi.fn();
  const capture = startDebugCapture(stdin, scratch, ended);
  capture.attach(input.stream);
  for (let i = 1; i < 8; i++) input.emit(input.stream.latest!, performance.now());
  expect(ended).not.toHaveBeenCalled();
  expect(capture.warning).toBeNull();
  release();
  await capture.finish();
  expect(capture.frameTimesUs).toHaveLength(9);
  expect(fs.writeFile).toHaveBeenCalledTimes(8);
});

it.skipIf(!hasEncoder)(
  "preflights an odd-width 4:2:0 JPEG supported by debug recording",
  async () => {
    const frame = jpeg([255, 0, 0], 1179, 2556, "yuvj420p");
    const image = path.join(scratch, "odd.jpg");
    await fs.writeFile(image, frame);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", image],
      { encoding: "utf8" }
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({
      width: 1179,
      height: 2556,
      pix_fmt: "yuvj420p",
    });
    await expect(verifyDebugEncoder("ffmpeg", frame)).resolves.toBeUndefined();
  }
);

it.skipIf(!hasEncoder || process.platform === "win32")(
  "identifies a timed-out debug preflight",
  async () => {
    const wrapper = path.join(scratch, "stalled-encoder");
    await fs.writeFile(wrapper, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`, {
      mode: 0o755,
    });
    const error = await verifyDebugEncoder(wrapper, jpeg([255, 0, 0])).catch((err: Error) => err);
    expect((error as Error).message).toContain("preflight timed out after 10 seconds");
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.SCREEN_RECORDING_START_TIMEOUT,
      error_kind: "timeout",
    });
  },
  15_000
);

it.skipIf(!hasEncoder || process.platform === "win32").each(["it's dir", "ci\\runner"])(
  "encodes from a POSIX spool named %s",
  async (name) => {
    const directory = path.join(scratch, name);
    await fs.mkdir(directory);
    const output = path.join(scratch, "quoted.mp4");
    const child = spawn(
      "ffmpeg",
      ffmpegArgs({
        outputFile: output,
        logoFile: null,
        graph: null,
        canvas: { width: 33, height: 31 },
        mode: "debug",
      })
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const capture = startDebugCapture(child.stdin, directory, vi.fn());
    capture.attach(source(jpeg([0, 0, 255])).stream);
    await capture.finish();
    expect(await closed, stderr).toBe(0);
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "json",
        output,
      ],
      { encoding: "utf8" }
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams[0].nb_read_frames).toBe("2");
  }
);

it.skipIf(!hasEncoder)("rejects a nonempty MP4 missing its movie metadata", async () => {
  const file = path.join(scratch, "unplayable.mp4");
  await fs.writeFile(file, Buffer.from("00000020ftypisom00000008mdat"));
  await expect(verifyDebugVideo("ffmpeg", file)).rejects.toThrow();
});

it.skipIf(process.platform === "win32")(
  "requires the debug preset and CRF during preflight",
  async () => {
    const wrapper = path.join(scratch, "probe-settings");
    await fs.writeFile(
      wrapper,
      `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[a.indexOf("-preset")+1] !== "ultrafast" || a[a.indexOf("-crf")+1] !== "12") { process.stderr.write("wrong debug settings"); process.exit(8); }\n`,
      { mode: 0o755 }
    );
    await expect(
      verifyDebugEncoder(wrapper, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    ).resolves.toBeUndefined();
  }
);

it.skipIf(process.platform === "win32")(
  "does not classify an external SIGKILL as a preflight timeout",
  async () => {
    const wrapper = path.join(scratch, "killed-probe");
    await fs.writeFile(wrapper, `#!${process.execPath}\nprocess.kill(process.pid, "SIGKILL");\n`, {
      mode: 0o755,
    });
    const error = await verifyDebugEncoder(wrapper, Buffer.from([0xff, 0xd8, 0xff, 0xd9])).catch(
      (err: Error) => err
    );
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.SCREEN_RECORDING_START_EXITED,
      error_kind: "subprocess",
    });
    expect((error as Error).message).not.toContain("timed out");
  }
);
