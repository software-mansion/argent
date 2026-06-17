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
  /** mach-absolute timestamp of the sample. */
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

  if (raw.length < 4 || raw.readUInt32LE(0) !== RAW_VERSION2) {
    return { callstacks, threadsPids, pidsNames };
  }

  // --- kd_header_v2 ---
  // numThreads u32@4, pad(8+4), is_64bit u32@16, tick_frequency u64@20,
  // pad(0x100), threadmap[numThreads] (each 32B: tid u64, pid u32, name char[20]),
  // then a run of zero padding until the first record.
  const numThreads = raw.readUInt32LE(4);
  // version(4) + numThreads(4) + pad(8) + pad(4) + is_64bit(4) + tick_frequency(8) = 32
  let off = 32;
  off += 0x100; // pad(256) → threadmap at 288
  for (let i = 0; i < numThreads; i++) {
    const tid = Number(raw.readBigUInt64LE(off));
    const pid = raw.readInt32LE(off + 8);
    let end = off + 12;
    let z = end;
    while (z < off + 32 && raw[z] !== 0) z++;
    const name = raw.toString("utf8", end, z);
    threadsPids.set(tid, pid);
    if (!pidsNames.has(pid)) pidsNames.set(pid, name);
    off += 32;
  }
  // skip zero padding to the first record (kd_header_v2 `_pad` = GreedyRange of 0)
  while (off < raw.length && raw[off] === 0) off++;

  // --- kd_buf records ---
  const open = new Map<number, OpenGroup>();
  for (; off + KEVENT_SIZE <= raw.length; off += KEVENT_SIZE) {
    const debugid = raw.readUInt32LE(off + 48);
    const eventid = debugid & 0xfffffffc;
    const func = debugid & 0x3;
    const tid = Number(raw.readBigUInt64LE(off + 40));

    if (eventid === PERF_EVENT) {
      if (func === 1) {
        // START — open a sample group for this thread
        open.set(tid, {
          ts: Number(raw.readBigUInt64LE(off)),
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

  return { callstacks, threadsPids, pidsNames };
}

/** Convenience: deframe a capture file and parse its kdebug stream. */
export function parseCapture(buf: Buffer): ParsedKdebug {
  const frames = deframe(buf);
  if (frames.length <= 1) return { callstacks: [], threadsPids: new Map(), pidsNames: new Map() };
  const raw = Buffer.concat(frames.slice(1)); // frame 0 = stackshot (unused)
  return parseKdebugStream(raw);
}
