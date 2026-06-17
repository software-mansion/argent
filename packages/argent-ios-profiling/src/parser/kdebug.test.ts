import { describe, it, expect } from "vitest";
import { parseKdebugStream } from "./kdebug";

// --- synthetic RAW_VERSION2 stream builder ---------------------------------
const RAW_VERSION2 = 0x55aa0200;
const PERF_EVENT = 0x25000000;
const PERF_STK_UHDR = 0x25020018;
const PERF_STK_UDATA = 0x25020010;
const SAMPLER_USTACK = 0x08;

/** One 64-byte kd_buf: ts@0, arg0..3@8/16/24/32, tid@40, debugid@48. */
function kdbuf(opts: { ts?: bigint; args?: bigint[]; tid?: bigint; debugid: number }): Buffer {
  const b = Buffer.alloc(64);
  b.writeBigUInt64LE(opts.ts ?? 0n, 0);
  const a = opts.args ?? [];
  for (let i = 0; i < 4; i++) b.writeBigUInt64LE(a[i] ?? 0n, 8 + i * 8);
  b.writeBigUInt64LE(opts.tid ?? 0n, 40);
  b.writeUInt32LE(opts.debugid >>> 0, 48);
  return b;
}

/** A complete USTACK sample (START → UHDR → UDATA → END) for one thread. */
function sample(tid: bigint, ts: bigint, frames: bigint[]): Buffer {
  return Buffer.concat([
    kdbuf({ tid, ts, args: [BigInt(SAMPLER_USTACK)], debugid: PERF_EVENT | 1 }),
    kdbuf({ tid, args: [0n, BigInt(frames.length)], debugid: PERF_STK_UHDR }),
    kdbuf({ tid, args: [frames[0] ?? 0n, frames[1] ?? 0n, 0n, 0n], debugid: PERF_STK_UDATA }),
    kdbuf({ tid, debugid: PERF_EVENT | 2 }),
  ]);
}

function header(numThreads: number, tickFreq: bigint): Buffer {
  const h = Buffer.alloc(288);
  h.writeUInt32LE(RAW_VERSION2, 0);
  h.writeUInt32LE(numThreads, 4);
  h.writeBigUInt64LE(tickFreq, 24);
  return h; // [32 header][256 pad] → threadmap starts at 288
}

function threadmapEntry(tid: bigint, pid: number, name: string): Buffer {
  const e = Buffer.alloc(32);
  e.writeBigUInt64LE(tid, 0);
  e.writeInt32LE(pid, 8);
  e.write(name, 12, "utf8");
  return e;
}

describe("parseKdebugStream", () => {
  it("parses tickFrequency, threadmap and a USTACK callstack", () => {
    const stream = Buffer.concat([
      header(1, 24_000_000n),
      threadmapEntry(7n, 42, "testproc"),
      sample(7n, 1000n, [0xaaaan, 0xbbbbn]),
    ]);
    const p = parseKdebugStream(stream);
    expect(p.tickFrequency).toBe(24_000_000);
    expect(p.threadsPids.get(7)).toBe(42);
    expect(p.pidsNames.get(42)).toBe("testproc");
    expect(p.callstacks).toHaveLength(1);
    expect(p.callstacks[0].tid).toBe(7);
    expect(p.callstacks[0].frames).toEqual([0xaaaan, 0xbbbbn]);
  });

  // Regression for the zero-padding alignment bug: a byte-wise "skip while 0"
  // eats the first record's zero low timestamp byte (~1/256 of streams) and
  // drops the ENTIRE record stream. Deterministic end-alignment must not.
  it("does not drop the stream when the first record timestamp has a zero low byte", () => {
    for (const ts of [0x100n, 0x2300n, 0x4500n, 0xff00n]) {
      const stream = Buffer.concat([
        header(1, 24_000_000n),
        threadmapEntry(7n, 42, "p"),
        Buffer.alloc(8), // leading zero pad between threadmap and records
        sample(7n, ts, [0xdeadn, 0xbeefn]),
      ]);
      const p = parseKdebugStream(stream);
      expect(p.callstacks, `ts=0x${ts.toString(16)}`).toHaveLength(1);
      expect(p.callstacks[0].frames).toEqual([0xdeadn, 0xbeefn]);
    }
  });

  // numThreads is stream-controlled; a capture killed mid-write must not throw.
  it("does not throw on a truncated threadmap (oversized numThreads)", () => {
    const truncated = Buffer.concat([
      header(1000, 24_000_000n), // claims 1000 threads…
      threadmapEntry(7n, 42, "p"), // …but only one is present
    ]);
    expect(() => parseKdebugStream(truncated)).not.toThrow();
    const p = parseKdebugStream(truncated);
    expect(p.threadsPids.get(7)).toBe(42);
  });

  it("returns empty for a non-RAW_VERSION2 / short buffer", () => {
    const p = parseKdebugStream(Buffer.from([1, 2, 3, 4]));
    expect(p.callstacks).toHaveLength(0);
    expect(p.tickFrequency).toBe(0);
  });
});
