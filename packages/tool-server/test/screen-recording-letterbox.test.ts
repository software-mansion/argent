import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ffmpegArgs } from "../src/tools/screen-recording/capture";
import { buildWatermarkGraph, writeLogoTemp } from "../src/tools/screen-recording/watermark";

/**
 * The recorder's real ffmpeg arguments over a synthetic MJPEG pipe whose
 * frames change size mid-stream, as a foldable's recording does when it moves
 * to the other panel's stream, or a screen that turns from portrait to
 * landscape. No device: the frames are solid-colour JPEGs, and the video is
 * decoded back to check that the frames of the other size are letterboxed
 * into the first frame's size, not stretched to fill it.
 */

interface Size {
  width: number;
  height: number;
}

/** The stretch the recording starts with, and the one after the change, each in a colour of its own. */
const FIRST_RGB = [0xe0, 0xa0, 0x30] as const;
const OTHER_RGB = [0x30, 0x70, 0xc0] as const;
const FRAMES_PER_STRETCH = 10;

interface Case {
  name: string;
  first: Size;
  other: Size;
  /** The video's size: the first frame's, evened. */
  video: Size;
  /** Where the bars go around the other frames, and how long the content between them runs. */
  bars: "rows" | "columns";
  content: number;
}

const CASES: Case[] = [
  {
    // The inner panel (2006x2852 once evened) at 1398 wide is 1398 * 2852 /
    // 2006 ~ 1988 tall, with ~23 rows of black above and below.
    name: "a foldable's cover, then its inner panel",
    first: { width: 1398, height: 2034 },
    other: { width: 2006, height: 2853 },
    video: { width: 1398, height: 2034 },
    bars: "rows",
    content: 1988,
  },
  {
    // The cover scaled up to the full 2852 height is 2852 * 1398 / 2034 ~
    // 1960 wide, with ~23 columns of black on each side.
    name: "a foldable's inner panel, then its cover",
    first: { width: 2006, height: 2853 },
    other: { width: 1398, height: 2034 },
    video: { width: 2006, height: 2852 },
    bars: "columns",
    content: 1960,
  },
  {
    // A landscape frame in a portrait video: 1080 * 1080 / 2400 = 486 tall.
    name: "a portrait screen, then a landscape one",
    first: { width: 1080, height: 2400 },
    other: { width: 2400, height: 1080 },
    video: { width: 1080, height: 2400 },
    bars: "rows",
    content: 486,
  },
];

function hasEncoder(): boolean {
  const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const probe = spawnSync("ffprobe", ["-version"]);
  return encoders.status === 0 && encoders.stdout.includes("libx264") && probe.status === 0;
}

const hex = (rgb: readonly number[]) =>
  "0x" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

function solidJpeg(size: Size, rgb: readonly number[]): Buffer {
  const out = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${hex(rgb)}:s=${size.width}x${size.height}`,
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (out.status !== 0) throw new Error(`could not make a JPEG: ${out.stderr.toString()}`);
  return out.stdout;
}

/** Feed the frames to ffmpeg with the recorder's own arguments; resolve on exit. */
function encode(
  args: string[],
  frames: Buffer[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
    for (const frame of frames) child.stdin.write(frame);
    child.stdin.end();
  });
}

interface DecodedFrame {
  /** Which stretch's colour the frame centre shows; null for neither. */
  shows: "first" | "other" | null;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Each decoded frame's stretch and black bars. Rows are read across a band of
 * columns at the centre and columns across a band of rows at the centre: the
 * content is centred between the bars, and the bottom-left watermark lies
 * outside both bands.
 */
function decodeFrames(file: string, { width, height }: Size): DecodedFrame[] {
  const decoded = spawnSync(
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
    { maxBuffer: 1024 * 1024 * 1024 }
  );
  expect(decoded.status).toBe(0);
  // A clean decode prints nothing at `-v error`.
  expect(decoded.stderr.toString()).toBe("");
  const frameBytes = width * height * 3;
  expect(decoded.stdout.length % frameBytes).toBe(0);
  const frames: DecodedFrame[] = [];
  for (let offset = 0; offset < decoded.stdout.length; offset += frameBytes) {
    const px = decoded.stdout.subarray(offset, offset + frameBytes);
    const bright = (x: number, y: number) => {
      const i = (y * width + x) * 3;
      return Math.max(px[i]!, px[i + 1]!, px[i + 2]!);
    };
    const band = (length: number) => [Math.floor(length * 0.4), Math.ceil(length * 0.6)] as const;
    const [x0, x1] = band(width);
    const [y0, y1] = band(height);
    const barRow = (y: number) => {
      let sum = 0;
      for (let x = x0; x < x1; x++) sum += bright(x, y);
      return sum / (x1 - x0) < 40;
    };
    const barColumn = (x: number) => {
      let sum = 0;
      for (let y = y0; y < y1; y++) sum += bright(x, y);
      return sum / (y1 - y0) < 40;
    };
    const run = (length: number, isBar: (i: number) => boolean, from: number, step: number) => {
      let n = 0;
      for (let i = from; n < length && isBar(i); i += step) n++;
      return n;
    };
    const centre = ((height >> 1) * width + (width >> 1)) * 3;
    const rgb = [px[centre]!, px[centre + 1]!, px[centre + 2]!];
    const near = (ref: readonly number[]) => rgb.every((c, i) => Math.abs(c - ref[i]!) <= 24);
    frames.push({
      shows: near(FIRST_RGB) ? "first" : near(OTHER_RGB) ? "other" : null,
      top: run(height, barRow, 0, 1),
      bottom: run(height, barRow, height - 1, -1),
      left: run(width, barColumn, 0, 1),
      right: run(width, barColumn, width - 1, -1),
    });
  }
  return frames;
}

function probe(file: string): Array<{ codec_type: string; width?: number; height?: number }> {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", file],
    { encoding: "utf8" }
  );
  expect(out.status).toBe(0);
  return (JSON.parse(out.stdout) as { streams: Array<{ codec_type: string }> }).streams;
}

/**
 * The stretches come back in order, and without the watermark, whole.
 * ffmpeg rebuilds the filter graph on a size change, and the watermark's
 * graph, which has a second input, loses the frames it held at that moment
 * (1 to 3 per change, measured; the same with or without the letterbox), so
 * there a stretch may come back a few frames short, never longer.
 */
function expectStretches(frames: DecodedFrame[], watermark: boolean) {
  const runs: Array<{ shows: DecodedFrame["shows"]; count: number }> = [];
  for (const { shows } of frames) {
    const last = runs.at(-1);
    if (last?.shows === shows) last.count++;
    else runs.push({ shows, count: 1 });
  }
  expect(runs.map((r) => r.shows)).toEqual(["first", "other", "first"]);
  for (const { count } of runs) {
    expect(count).toBeGreaterThanOrEqual(FRAMES_PER_STRETCH - (watermark ? 4 : 0));
    expect(count).toBeLessThanOrEqual(FRAMES_PER_STRETCH);
  }
}

describe.skipIf(!hasEncoder())("recording across a frame-size change (real ffmpeg)", () => {
  let dir = "";
  let logoFile = "";

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-letterbox-test-"));
    logoFile = await writeLogoTemp();
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    if (logoFile) await fs.rm(logoFile, { force: true });
  });

  /** first -> other -> first, one stretch each, with the recorder's own arguments. */
  async function record(c: Case, watermark: boolean): Promise<string> {
    const outputFile = path.join(dir, `${CASES.indexOf(c)}-${watermark}.mp4`);
    const canvas = c.first;
    const args = ffmpegArgs({
      outputFile,
      logoFile: watermark ? logoFile : null,
      graph: watermark ? buildWatermarkGraph(canvas) : null,
      canvas,
    });
    const first = solidJpeg(c.first, FIRST_RGB);
    const other = solidJpeg(c.other, OTHER_RGB);
    const frames = [
      ...Array<Buffer>(FRAMES_PER_STRETCH).fill(first),
      ...Array<Buffer>(FRAMES_PER_STRETCH).fill(other),
      ...Array<Buffer>(FRAMES_PER_STRETCH).fill(first),
    ];
    const { code, stderr } = await encode(args, frames);
    expect(code, stderr).toBe(0);
    return outputFile;
  }

  for (const c of CASES) {
    for (const watermark of [false, true]) {
      it(`keeps the first frame's size and letterboxes the other: ${c.name} (watermark ${watermark ? "on" : "off"})`, async () => {
        const file = await record(c, watermark);
        // One video stream, at the size the recording started with.
        expect(probe(file)).toEqual([{ codec_type: "video", ...c.video }]);
        const frames = decodeFrames(file, c.video);
        expectStretches(frames, watermark);
        const none = { top: 0, bottom: 0, left: 0, right: 0 };
        for (const { shows, top, bottom, left, right } of frames) {
          if (shows === "first") {
            expect({ top, bottom, left, right }).toEqual(none);
            continue;
          }
          // Aspect ratio kept: bars on one axis, centred, leaving the fitted
          // content between them. Stretched, the frame would have no bars.
          const [along, across, extent] =
            c.bars === "rows"
              ? [[top, bottom], [left, right], c.video.height]
              : [[left, right], [top, bottom], c.video.width];
          expect(across).toEqual([0, 0]);
          expect(Math.abs(extent - along[0]! - along[1]! - c.content)).toBeLessThanOrEqual(2);
          expect(Math.abs(along[0]! - along[1]!)).toBeLessThanOrEqual(2);
        }
      }, 60_000);
    }
  }
});
