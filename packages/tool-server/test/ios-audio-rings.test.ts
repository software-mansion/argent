import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  InputFeeder,
  OutputRecorder,
  readClipInfo,
  STREAM_RATE,
  type FeederSource,
} from "../src/utils/ios-audio-rings";

const HDR = 128;
const CAP = 1 << 16;
const LEAD = 14_400;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-rings-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A mono float32 WAV laid out like afconvert's: a padding chunk pushes `data` to byte 4096. */
function clipFile(samples: number[]): string {
  const pad = 4044;
  const h = Buffer.alloc(36 + 8 + pad + 8);
  h.write("RIFF", 0, "ascii");
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(STREAM_RATE, 24);
  h.writeUInt32LE(STREAM_RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write("FLLR", 36, "ascii");
  h.writeUInt32LE(pad, 40);
  h.write("data", 36 + 8 + pad, "ascii");
  h.writeUInt32LE(samples.length * 4, 36 + 8 + pad + 4);
  const body = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => body.writeFloatLE(v, i * 4));
  const file = path.join(dir, `clip-${Math.random()}.wav`);
  fs.writeFileSync(file, Buffer.concat([h, body]));
  return file;
}

function clipSource(samples: number[], loop = false): FeederSource {
  const fd = fs.openSync(clipFile(samples), "r");
  return { kind: "clip", fd, info: readClipInfo(fd), loop };
}

class FakeApp {
  readonly fd: number;
  constructor(ringPath: string) {
    this.fd = fs.openSync(ringPath, "r+");
  }
  u32(pos: number): number {
    const b = Buffer.alloc(4);
    fs.readSync(this.fd, b, 0, 4, pos);
    return b.readUInt32LE(0);
  }
  set(pos: number, v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    fs.writeSync(this.fd, b, 0, 4, pos);
  }
  /** Reads `n` frames of the in ring from `from`, as the app does. */
  frames(from: number, n: number): number[] {
    const b = Buffer.alloc(4);
    return Array.from({ length: n }, (_, i) => {
      fs.readSync(this.fd, b, 0, 4, HDR + ((from + i) & (CAP - 1)) * 4);
      return b.readFloatLE(0);
    });
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

describe("readClipInfo", () => {
  it("finds the samples past a padding chunk", () => {
    const fd = fs.openSync(clipFile([0.1, 0.2, 0.3]), "r");
    expect(readClipInfo(fd)).toEqual({ dataOffset: 4096, frames: 3 });
    fs.closeSync(fd);
  });

  it("rejects anything that is not mono float32 at the stream rate", () => {
    const file = path.join(dir, "int16.wav");
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.write("WAVEfmt ", 8, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(STREAM_RATE, 24);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii");
    fs.writeFileSync(file, h);
    const fd = fs.openSync(file, "r");
    expect(() => readClipInfo(fd)).toThrow("unexpected format");
    fs.closeSync(fd);
  });
});

describe("InputFeeder", () => {
  it("buffers a lead of the stream before any app reads", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), {
      kind: "tone",
      frequencyHz: 1000,
      amplitude: 0.5,
    });
    for (let i = 0; i < 4; i++) feeder.step(); // a tick writes at most 100 ms
    const app = new FakeApp(feeder.ringPath);
    expect(app.u32(0)).toBe(0x49475241);
    expect(app.u32(16)).toBe(LEAD); // writeFrame: a lead, no more
    expect(app.u32(20)).toBe(1); // streamGen
    const [a, b, c] = app.frames(0, 3);
    expect(a).toBe(0);
    expect(b).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 1000) / STREAM_RATE), 5);
    expect(c).toBeCloseTo(0.5 * Math.sin((4 * Math.PI * 1000) / STREAM_RATE), 5);
    app.close();
    feeder.stop();
  });

  it("follows the app's read cursor instead of a clock", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), {
      kind: "tone",
      frequencyHz: 440,
      amplitude: 0.3,
    });
    const app = new FakeApp(feeder.ringPath);
    for (let i = 0; i < 4; i++) feeder.step();
    expect(app.u32(16)).toBe(LEAD);
    app.set(64, 5_000); // readFrame
    for (let i = 0; i < 4; i++) feeder.step();
    expect(app.u32(16)).toBe(5_000 + LEAD);
    for (let i = 0; i < 4; i++) feeder.step();
    expect(app.u32(16)).toBe(5_000 + LEAD); // nothing consumed, nothing written
    app.close();
    feeder.stop();
  });

  it("plays a clip once and then silence", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => (i + 1) / 1000);
    const feeder = new InputFeeder(path.join(dir, "in.ring"), clipSource(samples));
    for (let i = 0; i < 4; i++) feeder.step();
    const app = new FakeApp(feeder.ringPath);
    const heard = app.frames(0, 1004);
    heard.slice(0, 1000).forEach((v, i) => expect(v).toBeCloseTo(samples[i], 6));
    expect(heard.slice(1000)).toEqual([0, 0, 0, 0]);
    app.close();
    feeder.stop();
  });

  it("loops a clip", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), clipSource([0.1, 0.2, 0.3], true));
    for (let i = 0; i < 4; i++) feeder.step();
    const app = new FakeApp(feeder.ringPath);
    app.frames(0, 8).forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3][i % 3], 6));
    app.close();
    feeder.stop();
  });

  it("rewinds the stream when the app asks, so it plays from its start again", () => {
    const samples = Array.from({ length: 2000 }, (_, i) => (i + 1) / 2000);
    const feeder = new InputFeeder(path.join(dir, "in.ring"), clipSource(samples));
    const app = new FakeApp(feeder.ringPath);
    for (let i = 0; i < 4; i++) feeder.step();
    app.set(64, 3_000); // the app consumed past the end of the clip
    for (let i = 0; i < 4; i++) feeder.step();
    const before = app.u32(16);

    app.set(68, 1); // requestGen: the app stopped and started capturing again
    feeder.step();
    expect(app.u32(20)).toBe(2); // streamGen
    expect(app.u32(24)).toBe(before); // streamStart is where the host had written up to
    for (let i = 0; i < 4; i++) feeder.step();
    expect(app.frames(before, 3).map((v) => Math.round(v * 2000))).toEqual([1, 2, 3]);
    app.close();
    feeder.stop();
  });

  it("rewinds before the app's cursor is 2^31 past the stream start", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), {
      kind: "tone",
      frequencyHz: 100,
      amplitude: 1,
    });
    const app = new FakeApp(feeder.ringPath);
    feeder.step();
    expect(app.u32(20)).toBe(1);
    app.set(64, 2 ** 30); // six hours of listening
    feeder.step();
    expect(app.u32(20)).toBe(2); // rewound
    expect(app.u32(24)).toBe(app.u32(16)); // the new start is where the host had written up to
    app.close();
    feeder.stop();
  });

  it("restarts for a new source and closes the old clip", () => {
    const first = clipSource([0.5, 0.5, 0.5]);
    const feeder = new InputFeeder(path.join(dir, "in.ring"), first);
    feeder.step();
    feeder.setSource({ kind: "tone", frequencyHz: 100, amplitude: 1 });
    expect(() => fs.fstatSync((first as { fd: number }).fd)).toThrow(); // closed
    const app = new FakeApp(feeder.ringPath);
    expect(app.u32(20)).toBe(2);
    app.close();
    feeder.stop();
  });

  it("stops without throwing twice", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), {
      kind: "tone",
      frequencyHz: 1,
      amplitude: 1,
    });
    feeder.stop();
    expect(() => feeder.stop()).not.toThrow();
    expect(feeder.running).toBe(false);
  });
});

describe("OutputRecorder", () => {
  /** Plays the app: stores frames of `channels` float32 samples and publishes the counters. */
  function appWrites(ringPath: string, channels: number, from: number, frames: number[][]): number {
    const app = new FakeApp(ringPath);
    const b = Buffer.alloc(channels * 4);
    frames.forEach((f, i) => {
      b.fill(0);
      f.forEach((v, k) => b.writeFloatLE(v, k * 4));
      fs.writeSync(app.fd, b, 0, b.length, HDR + ((from + i) & (CAP - 1)) * b.length);
    });
    app.set(16, channels);
    app.set(20, STREAM_RATE);
    app.set(24, from + frames.length);
    app.close();
    return from + frames.length;
  }

  function samples(wav: string): number[] {
    const b = fs.readFileSync(wav);
    return Array.from({ length: (b.length - 44) / 2 }, (_, i) => b.readInt16LE(44 + i * 2));
  }

  it("writes a 16-bit WAV of what the app played", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    rec.step();
    expect(fs.existsSync(path.join(dir, "out.wav"))).toBe(false); // nothing played yet
    const w = appWrites(rec.ringPath, 2, 0, [
      [0.5, -0.5],
      [1.5, -1.5], // clipped
      [0, 0.25],
    ]);
    rec.step();
    const done = rec.finish();
    expect(done).toMatchObject({
      frames: w,
      droppedFrames: 0,
      channels: 2,
      sampleRate: STREAM_RATE,
    });
    expect(samples(done.path)).toEqual([16384, -16383, 32767, -32767, 0, 8192]);

    const h = fs.readFileSync(done.path);
    expect(h.toString("ascii", 0, 4)).toBe("RIFF");
    expect(h.readUInt32LE(40)).toBe(3 * 2 * 2); // data length
    expect(h.readUInt16LE(22)).toBe(2);
    expect(h.readUInt32LE(24)).toBe(STREAM_RATE);
    expect(fs.existsSync(rec.ringPath)).toBe(false); // the ring is removed
  });

  it("appends across drains", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    const w = appWrites(rec.ringPath, 1, 0, [[0.25], [0.5]]);
    rec.step();
    appWrites(rec.ringPath, 1, w, [[-0.25]]);
    rec.step();
    expect(samples(rec.finish().path)).toEqual([8192, 16384, -8192]);
  });

  it("counts frames the app wrote faster than they were drained", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    appWrites(rec.ringPath, 1, 0, [[0.1]]);
    rec.step();
    const app = new FakeApp(rec.ringPath);
    app.set(24, 1 + CAP + 100); // the app ran a full ring ahead
    app.close();
    const done = rec.finish();
    expect(done.droppedFrames).toBe(CAP + 100 - CAP / 2);
    expect(done.frames).toBe(1 + CAP / 2);
  });

  it("keeps draining after a lag of more than 2^31 frames", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    appWrites(rec.ringPath, 1, 0, [[0.1]]);
    rec.step();
    const app = new FakeApp(rec.ringPath);
    app.set(24, (1 + 2 ** 31 + 5) >>> 0); // the host slept for 12 hours
    app.close();
    const done = rec.finish();
    expect(done.frames).toBe(1 + CAP / 2);
    expect(done.droppedFrames).toBe(2 ** 31 + 5 - CAP / 2);
  });

  it("leaves a valid empty file when the app never played", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    const done = rec.finish();
    expect(done).toMatchObject({ frames: 0, channels: 1, sampleRate: STREAM_RATE });
    expect(fs.readFileSync(done.path).length).toBe(44);
  });

  it("abort removes both files", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    appWrites(rec.ringPath, 1, 0, [[0.1]]);
    rec.step();
    rec.abort();
    expect(fs.existsSync(rec.ringPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, "out.wav"))).toBe(false);
  });
});

/**
 * The hook in the app maps these files with its own copy of the layout (ArgentAudio.c in argent-private:
 * `InRing`, `OutRing`, `RING_HDR`, `MAGIC_IN`, `MAGIC_OUT`, `OUT_MAX_CH`). Neither side can see the other's
 * constants, so they are pinned here.
 */
describe("ring layout shared with the hook", () => {
  const header = (ringPath: string) => {
    const app = new FakeApp(ringPath);
    const fields = Array.from({ length: 19 }, (_, i) => app.u32(i * 4));
    app.close();
    return fields;
  };

  it("in ring: magic, version, rate, cap, then the host counters at 16/20/24 and the app's at 64/68/72", () => {
    const feeder = new InputFeeder(path.join(dir, "in.ring"), {
      kind: "tone",
      frequencyHz: 1000,
      amplitude: 0.5,
    });
    feeder.step();
    expect(fs.statSync(feeder.ringPath).size).toBe(HDR + CAP * 4);
    const h = header(feeder.ringPath);
    expect(h.slice(0, 4)).toEqual([0x49475241, 1, STREAM_RATE, 65_536]);
    expect(h[4]).toBeGreaterThan(0); // 16 writeFrame
    expect(h[5]).toBe(1); // 20 streamGen
    expect(h[6]).toBe(0); // 24 streamStart
    expect(h.slice(7, 16)).toEqual(Array(9).fill(0)); // 28..63 padding
    expect(h.slice(16, 19)).toEqual([0, 0, 0]); // 64 readFrame, 68 requestGen, 72 owner: the app's
    feeder.stop();
  });

  it("out ring: magic, version, cap, max channels 8, then the app's counters at 16/20/24", () => {
    const rec = new OutputRecorder(path.join(dir, "out.ring"), path.join(dir, "out.wav"));
    expect(fs.statSync(rec.ringPath).size).toBe(HDR + CAP * 8 * 4);
    const h = header(rec.ringPath);
    expect(h.slice(0, 4)).toEqual([0x4f475241, 1, 65_536, 8]);
    expect(h.slice(4, 7)).toEqual([0, 0, 0]); // channels, rate, writeFrame
    rec.abort();
  });

  const source = path.resolve(
    __dirname,
    "../../argent-private/packages/native-devtools-ios/Sources/NativeDevtoolsIos/ArgentAudio.c"
  );
  it.skipIf(!fs.existsSync(source))("matches the constants of ArgentAudio.c", async () => {
    const c = fs.readFileSync(source, "utf8");
    const define = (name: string) => new RegExp(`#define ${name} ([^\\s/]+)`).exec(c)?.[1];
    expect(define("RING_HDR")).toBe(String(HDR));
    expect(define("MAGIC_IN")).toBe("0x49475241u");
    expect(define("MAGIC_OUT")).toBe("0x4F475241u");
    expect(define("OUT_MAX_CH")).toBe("8u");
    const { AUDIO_HOOK_PROTO } = await import("../src/utils/ios-audio");
    expect(define("PROTO")).toBe(String(AUDIO_HOOK_PROTO));
    // The hook refuses a ring larger than this.
    expect(c).toMatch(/#define RING_MAX_CAP \(1u << 20\)/);
    expect(CAP).toBeLessThanOrEqual(1 << 20);
  });
});
