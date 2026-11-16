import * as fs from "node:fs";
import { FAILURE_CODES, FailureError } from "@argent/registry";

/**
 * The host end of the ring the iOS Simulator audio mock moves microphone samples through. The ring is a regular file
 * the host creates in the simulator's control directory and the hook in the app reads (its half of the layout below
 * is in argent-private), so the app only copies samples: decoding, tone generation and pacing all happen here.
 *
 *   in ring   (host -> app)  header, then `RING_CAP` float32 mono frames at `STREAM_RATE`
 *     16 writeFrame   host   frames written, modulo 2^32
 *     20 streamGen    host   bumped whenever the stream is rewound
 *     24 streamStart  host   frame the rewound stream starts at
 *     64 readFrame    app    frames consumed
 *     68 requestGen   app    bumped when the app starts capturing again and wants the stream from its start
 *
 * The in ring is paced by the app's read cursor, not a host clock: the feeder keeps `LEAD_FRAMES` of samples ahead
 * of it, so the two clocks never drift apart and a stream starts from its beginning when the app starts reading.
 */

const RING_HDR = 128;
const IN_MAGIC = 0x49475241; // "ARGI"
const RING_CAP = 1 << 16;
export const STREAM_RATE = 48_000;
/** How far ahead of the app's read cursor the feeder stays: the longest event-loop stall it rides out. */
const LEAD_FRAMES = 14_400;
const MAX_CHUNK = 4_800;
const FEED_TICK_MS = 10;

function putU32(fd: number, pos: number, value: number): void {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  fs.writeSync(fd, b, 0, 4, pos);
}

/** Creates a ring file with its header written and every page allocated. */
function createRing(ringPath: string, header: number[], dataBytes: number): number {
  const fd = fs.openSync(ringPath, "w+", 0o600);
  const hdr = Buffer.alloc(RING_HDR);
  header.forEach((v, i) => hdr.writeUInt32LE(v >>> 0, i * 4));
  fs.writeSync(fd, hdr, 0, RING_HDR, 0);
  // Written, not just truncated: the app must never wait on the filesystem to allocate a page.
  fs.writeSync(fd, Buffer.alloc(dataBytes), 0, dataBytes, RING_HDR);
  return fd;
}

export interface ClipInfo {
  dataOffset: number;
  frames: number;
}

/** Locates the samples of the mono float32 WAV that `afconvert` wrote (it pads before `data`, so walk the chunks). */
export function readClipInfo(fd: number): ClipInfo {
  const head = Buffer.alloc(16_384);
  const read = fs.readSync(fd, head, 0, head.length, 0);
  const size = fs.fstatSync(fd).size;
  const bad = (why: string) =>
    new FailureError(`The converted clip is not mono float32 WAV (${why}).`, {
      error_code: FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED,
      failure_stage: "audio_clip_conversion",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  if (read < 12 || head.toString("ascii", 0, 4) !== "RIFF") throw bad("no RIFF header");
  let fmtOk = false;
  for (let pos = 12; pos + 8 <= read;) {
    const id = head.toString("ascii", pos, pos + 4);
    const len = head.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      const tag = head.readUInt16LE(pos + 8);
      const channels = head.readUInt16LE(pos + 10);
      const rate = head.readUInt32LE(pos + 12);
      const bits = head.readUInt16LE(pos + 22);
      fmtOk = tag === 3 && channels === 1 && bits === 32 && rate === STREAM_RATE;
    } else if (id === "data") {
      if (!fmtOk) throw bad("unexpected format");
      const dataOffset = pos + 8;
      // A streamed WAV can carry a bogus length: trust the file size when it is smaller.
      return { dataOffset, frames: Math.floor(Math.min(len, size - dataOffset) / 4) };
    }
    pos += 8 + len + (len & 1);
  }
  throw bad("no data chunk");
}

export type FeederSource =
  /** `plays` is the number of times the clip plays before silence; any count works, up to practically forever. */
  | { kind: "clip"; fd: number; info: ClipInfo; plays: number }
  | { kind: "tone"; frequencyHz: number; amplitude: number };

function closeSource(source: FeederSource): void {
  if (source.kind === "clip") fs.closeSync(source.fd);
}

/**
 * Keeps the in ring topped up with the selected clip or tone. Only the tool-server drives it, on a timer; `step`
 * is the whole tick, exposed so tests can run it without one.
 */
export class InputFeeder {
  private readonly fd: number;
  private readonly samples = new Float32Array(MAX_CHUNK);
  private readonly bytes = Buffer.from(this.samples.buffer);
  private readonly guest = Buffer.alloc(12);
  private writeFrame = 0;
  private streamGen = 0;
  private streamStart = 0;
  private lastRequest: number;
  private clipPos = 0;
  /**
   * Times the clip started again since the stream started. A count past 2^53 stops growing (x + 1 === x), so a
   * larger `plays` never ends; reaching 2^53 plays takes thousands of years even for a one-frame clip.
   */
  private replays = 0;
  private phase = 0;
  private timer: NodeJS.Timeout | undefined;
  running = true;

  constructor(
    readonly ringPath: string,
    private source: FeederSource
  ) {
    this.fd = createRing(ringPath, [IN_MAGIC, 1, STREAM_RATE, RING_CAP], RING_CAP * 4);
    this.lastRequest = this.readGuest().requestGen;
    this.restart();
  }

  /** Switches to a new source; every app reading the ring hears it from its start. */
  setSource(source: FeederSource): void {
    closeSource(this.source);
    this.source = source;
    this.restart();
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.step();
      } catch (err) {
        process.stderr.write(`[audio] input feeder stopped: ${String(err)}\n`);
        this.stop();
      }
    }, FEED_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    closeSource(this.source);
    fs.closeSync(this.fd);
  }

  step(): void {
    const { readFrame, requestGen } = this.readGuest();
    if (requestGen !== this.lastRequest) {
      this.lastRequest = requestGen;
      this.restart();
    }
    // Right after a rewind the app's cursor still points into the old stream: count from the new start. The
    // comparison is a signed 32-bit difference, so an app that listened for 2^30 frames (6 h) since the last rewind
    // is rewound here before the difference could flip. That rewind keeps the source where it is: a clip that
    // played its count stays silent.
    const since = (readFrame - this.streamStart) >>> 0;
    if (since >= 2 ** 30 && since < 2 ** 31) {
      this.rewind();
      return;
    }
    const base = ((readFrame - this.streamStart) | 0) < 0 ? this.streamStart : readFrame;
    const need = (base + LEAD_FRAMES - this.writeFrame) | 0;
    if (need <= 0) return;
    const n = Math.min(need, MAX_CHUNK);
    this.produce(n);
    const start = this.writeFrame & (RING_CAP - 1);
    const first = Math.min(n, RING_CAP - start);
    fs.writeSync(this.fd, this.bytes, 0, first * 4, RING_HDR + start * 4);
    if (n > first) fs.writeSync(this.fd, this.bytes, first * 4, (n - first) * 4, RING_HDR);
    this.writeFrame = (this.writeFrame + n) >>> 0;
    putU32(this.fd, 16, this.writeFrame);
  }

  private readGuest(): { readFrame: number; requestGen: number } {
    fs.readSync(this.fd, this.guest, 0, 12, 64);
    return { readFrame: this.guest.readUInt32LE(0), requestGen: this.guest.readUInt32LE(4) };
  }

  /** The source starts again from its beginning, with its full play count, at the next frame written. */
  private restart(): void {
    this.clipPos = 0;
    this.replays = 0;
    this.phase = 0;
    this.rewind();
  }

  /** The app's stream continues from the next frame written; the app picks that up through the header. */
  private rewind(): void {
    this.streamStart = this.writeFrame;
    putU32(this.fd, 24, this.streamStart);
    this.streamGen = (this.streamGen + 1) >>> 0 || 1;
    putU32(this.fd, 20, this.streamGen);
  }

  private produce(n: number): void {
    const s = this.source;
    if (s.kind === "tone") {
      const step = s.frequencyHz / STREAM_RATE;
      for (let i = 0; i < n; i++) {
        this.samples[i] = s.amplitude * Math.sin(2 * Math.PI * this.phase);
        this.phase = (this.phase + step) % 1;
      }
      return;
    }
    let off = 0;
    while (off < n) {
      if (this.clipPos >= s.info.frames) {
        if (s.info.frames === 0 || this.replays + 1 >= s.plays) break;
        this.replays++;
        this.clipPos = 0;
      }
      const take = Math.min(s.info.frames - this.clipPos, n - off);
      const got = fs.readSync(
        s.fd,
        this.bytes,
        off * 4,
        take * 4,
        s.info.dataOffset + this.clipPos * 4
      );
      const frames = Math.floor(got / 4);
      if (frames === 0) {
        this.clipPos = s.info.frames; // the file is shorter than its header says
        break;
      }
      this.clipPos += frames;
      off += frames;
    }
    this.samples.fill(0, off, n); // past the last play of the clip: silence
  }
}

/** The in ring's write cursor and the app's read cursor, or null when the ring is gone or unreadable. */
function readInCursors(ringPath: string): { write: number; read: number } | null {
  try {
    const fd = fs.openSync(ringPath, "r");
    try {
      const b = Buffer.alloc(RING_HDR);
      if (fs.readSync(fd, b, 0, RING_HDR, 0) < 68 || b.readUInt32LE(0) !== IN_MAGIC) return null;
      return { write: b.readUInt32LE(16), read: b.readUInt32LE(64) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Whether nobody feeds this in ring any more, for an input file that does not name its owner. A live feeder stays
 * `LEAD_FRAMES` ahead of the app's cursor and tops the ring up within a tick of the app reading, so a ring an app
 * drained whose write cursor then stands still for `windowMs` has no feeder. While no app reads, a live and a dead
 * feeder look the same: that says no, which only keeps a file nobody hears yet.
 */
export async function feederGone(ringPath: string, windowMs = 1_000): Promise<boolean> {
  const before = readInCursors(ringPath);
  if (!before) return true;
  if (((before.write - before.read) | 0) >= LEAD_FRAMES / 2) return false;
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = readInCursors(ringPath);
  return !after || after.write === before.write;
}
