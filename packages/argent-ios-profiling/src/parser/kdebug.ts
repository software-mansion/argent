// TypeScript port of the pykdebugparser callstack path (the only part we use).
//
// The native capture writes a length-framed file: frame 0 is a kcdata stackshot
// (unused — we symbolicate via `atos`), frames 1+ concatenate into a kdebug
// RAW_VERSION2 stream. This module deframes, parses that stream, and reconstructs
// kperf user-stack callstacks plus the tid→pid / pid→name threadmap.
//
// Reference: pykdebugparser (kd_buf_parser.py, traces_parser.py,
// trace_handlers/perf.py). kd_buf record = `<Q 32s Q I I Q>` (64 bytes).

const RAW_VERSION2 = 0x55aa0200; // bytes 00 02 aa 55, little-endian u32
const KEVENT_SIZE = 64;

// kperf trace-code eventids (eventid = debugid & 0xFFFFFFFC)
const PERF_EVENT = 0x25000000; // brackets a sample (func START=1 / END=2)
const PERF_THD_DATA = 0x25010004; // args: [pid, tid, dq_addr, runmode]
const PERF_STK_UHDR = 0x25020018; // args: [flags, nframes]
const PERF_STK_UDATA = 0x25020010; // args: up to 4 user-stack frame addresses

// sample_what flags (PERF_Event arg0)
const SAMPLER_USTACK = 0x08;

export interface Callstack {
  /** sample timestamp in mach ticks, relative to the first sample (convert via tickFrequency). */
  timestamp: number;
  /** sampled thread id. */
  tid: number;
  /** user-stack frame addresses, leaf-first. */
  frames: bigint[];
}

export interface ParsedKdebug {
  callstacks: Callstack[];
  /** tid → pid (from the threadmap + PERF_THD_Data events). */
  threadsPids: Map<number, number>;
  /** pid → process name (from the threadmap). */
  pidsNames: Map<number, string>;
  /**
   * kd_header_v2 tick_frequency (ticks/sec). Lets consumers convert the
   * mach-tick timestamps to real time (ns = ticks * 1e9 / tickFrequency).
   * 0 when unknown (empty/short stream).
   */
  tickFrequency: number;
}

/** Split the capture file into its length-prefixed frames (`<u32 len><bytes>`). */
export function deframe(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    if (off + len > buf.length) break;
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return frames;
}

interface OpenGroup {
  ts: number;
  sampleWhat: number;
  nframes: number;
  frames: bigint[];
}

/**
 * Parse a kdebug RAW_VERSION2 stream (the concatenation of capture frames 1+)
 * into kperf user-stack callstacks. Mirrors pykdebugparser's `callstacks()`.
 */
export function parseKdebugStream(raw: Buffer): ParsedKdebug {
  const threadsPids = new Map<number, number>();
  const pidsNames = new Map<number, string>();
  const callstacks: Callstack[] = [];

  if (raw.length < 32 || raw.readUInt32LE(0) !== RAW_VERSION2) {
    return { callstacks, threadsPids, pidsNames, tickFrequency: 0 };
  }

  // --- kd_header_v2 (after the 4-byte magic) ---
  // number_of_threads u32@4, pad(8), pad(4), is_64bit u32@20, tick_frequency u64@24,
  // pad(0x100), threadmap[numThreads] (each 32B: tid u64, pid u32, name char[20]),
  // then a run of zero padding until the first record.
  const numThreads = raw.readUInt32LE(4);
  const tickFrequency = Number(raw.readBigUInt64LE(24));
  // magic(4) + numThreads(4) + pad(8) + pad(4) + is_64bit(4) + tick_frequency(8) = 32
  let off = 32;
  off += 0x100; // pad(256) → threadmap at 288
  for (let i = 0; i < numThreads; i++) {
    // numThreads is attacker/stream-controlled; never read past the buffer (a
    // capture killed mid-write otherwise throws an opaque RangeError).
    if (off + 32 > raw.length) break;
    const tid = Number(raw.readBigUInt64LE(off));
    const pid = raw.readInt32LE(off + 8);
    const end = off + 12;
    let z = end;
    while (z < off + 32 && raw[z] !== 0) z++;
    const name = raw.toString("utf8", end, z);
    threadsPids.set(tid, pid);
    if (!pidsNames.has(pid)) pidsNames.set(pid, name);
    off += 32;
  }
  // Locate the first kd_buf record. The header pads with a GreedyRange of zero
  // bytes, but a byte-wise "skip while 0" misaligns the 64-byte grid whenever the
  // first record's leading u64 timestamp has a zero low byte (~1/256), silently
  // dropping the ENTIRE record stream. Instead align deterministically from the
  // end: records are a whole number of 64-byte kd_bufs ending at the buffer end,
  // so the leading pad length ≡ (remaining bytes) mod 64. Any extra all-zero
  // 64-byte slots left in front parse as eventid 0 and are skipped harmlessly.
  if (off < raw.length) off += (raw.length - off) % KEVENT_SIZE;

  // --- kd_buf records ---
  // Timestamps are stored relative to the first sample so the u64→number narrowing
  // stays exact: the absolute mach time can exceed 2^53 (e.g. an ns-reporting x86
  // sim past ~104 days uptime), but a per-capture delta never does. The bigint
  // subtraction happens BEFORE narrowing, so no low bits are lost.
  let baseTs: bigint | null = null;
  const open = new Map<number, OpenGroup>();
  for (; off + KEVENT_SIZE <= raw.length; off += KEVENT_SIZE) {
    const debugid = raw.readUInt32LE(off + 48);
    const eventid = debugid & 0xfffffffc;
    const func = debugid & 0x3;
    const tid = Number(raw.readBigUInt64LE(off + 40));

    if (eventid === PERF_EVENT) {
      if (func === 1) {
        // START — open a sample group for this thread
        const tsRaw = raw.readBigUInt64LE(off);
        if (baseTs === null) baseTs = tsRaw;
        open.set(tid, {
          ts: Number(tsRaw - baseTs), // relative ticks (exact; see note above)
          sampleWhat: Number(raw.readBigUInt64LE(off + 8)), // arg0
          nframes: -1,
          frames: [],
        });
      } else if (func === 2) {
        // END — finalize the sample
        const g = open.get(tid);
        if (g) {
          open.delete(tid);
          if (g.sampleWhat & SAMPLER_USTACK && g.nframes >= 0) {
            callstacks.push({ timestamp: g.ts, tid, frames: g.frames.slice(0, g.nframes) });
          }
        }
      }
      continue;
    }

    const g = open.get(tid);
    if (g === undefined) {
      if (eventid === PERF_THD_DATA) {
        // tid→pid can also arrive outside an open group
        threadsPids.set(
          Number(raw.readBigUInt64LE(off + 16)),
          Number(raw.readBigUInt64LE(off + 8))
        );
      }
      continue;
    }
    if (eventid === PERF_STK_UHDR) {
      g.nframes = Number(raw.readBigUInt64LE(off + 16)); // arg1
    } else if (eventid === PERF_STK_UDATA) {
      // arg0..arg3 = up to 4 frame addresses
      g.frames.push(
        raw.readBigUInt64LE(off + 8),
        raw.readBigUInt64LE(off + 16),
        raw.readBigUInt64LE(off + 24),
        raw.readBigUInt64LE(off + 32)
      );
    } else if (eventid === PERF_THD_DATA) {
      threadsPids.set(Number(raw.readBigUInt64LE(off + 16)), Number(raw.readBigUInt64LE(off + 8)));
    }
  }

  return { callstacks, threadsPids, pidsNames, tickFrequency };
}

/** Convenience: deframe a capture file and parse its kdebug stream. */
export function parseCapture(buf: Buffer): ParsedKdebug {
  const frames = deframe(buf);
  if (frames.length <= 1) {
    return { callstacks: [], threadsPids: new Map(), pidsNames: new Map(), tickFrequency: 0 };
  }
  const raw = Buffer.concat(frames.slice(1)); // frame 0 = stackshot (unused)
  return parseKdebugStream(raw);
}
