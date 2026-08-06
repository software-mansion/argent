import { describe, it, expect } from "vitest";
import {
  stripHangTimestamp,
  isKeyframe,
  trimToRecentGop,
} from "../src/tools/screen-recording/moq-video-stream";
import { createAnnexbWriter } from "../src/tools/screen-recording/moq-capture";

// A minimal Annex-B access unit: 4-byte start code + one NAL of the given type.
function annexb(nalType: number, startCode3 = false): Buffer {
  const sc = startCode3 ? [0x00, 0x00, 0x01] : [0x00, 0x00, 0x00, 0x01];
  // nal_ref_idc=3 (0x60) | type; e.g. type 7 → 0x67, type 5 → 0x65, type 1 → 0x61.
  return Buffer.from([...sc, 0x60 | nalType, 0xde, 0xad]);
}

describe("stripHangTimestamp", () => {
  it("strips a 1-byte VarInt (top bits 00 → length 1)", () => {
    const body = annexb(7);
    const frame = Buffer.concat([Buffer.from([0x05]), body]); // 0x05: prefix 00
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips a 2-byte VarInt (top bits 01 → length 2)", () => {
    const body = annexb(1);
    const frame = Buffer.concat([Buffer.from([0x40, 0x05]), body]); // 0x40: prefix 01
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips a 4-byte VarInt (top bits 10 → length 4)", () => {
    const body = annexb(5);
    // 0x8b… mirrors the real server frames observed on the wire.
    const frame = Buffer.concat([Buffer.from([0x8b, 0xf9, 0x41, 0x39]), body]);
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips an 8-byte VarInt (top bits 11 → length 8)", () => {
    const body = annexb(1);
    const frame = Buffer.concat([Buffer.from([0xc0, 1, 2, 3, 4, 5, 6, 7]), body]);
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("returns empty for an empty frame", () => {
    expect(stripHangTimestamp(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });

  it("clamps when the VarInt length exceeds the frame", () => {
    // 0xc0 claims an 8-byte VarInt but only 3 bytes follow.
    expect(stripHangTimestamp(Buffer.from([0xc0, 1, 2]))).toEqual(Buffer.alloc(0));
  });
});

describe("isKeyframe", () => {
  it("detects an SPS NAL (type 7) as a keyframe", () => {
    expect(isKeyframe(annexb(7))).toBe(true);
    expect(isKeyframe(annexb(7, /* startCode3 */ true))).toBe(true);
  });

  it("detects an IDR slice (type 5) as a keyframe", () => {
    expect(isKeyframe(annexb(5))).toBe(true);
  });

  it("does not flag a non-IDR slice (type 1)", () => {
    expect(isKeyframe(annexb(1))).toBe(false);
  });

  it("does not flag a bare byte string with no start code", () => {
    expect(isKeyframe(Buffer.from([0x27, 0x00, 0x00]))).toBe(false);
    expect(isKeyframe(Buffer.alloc(0))).toBe(false);
  });

  it("finds the SPS even when a leading PPS-like NAL precedes it", () => {
    // PPS (type 8) then SPS (type 7): a real keyframe AU leads with SPS/PPS.
    const pps = annexb(8);
    const sps = annexb(7);
    expect(isKeyframe(Buffer.concat([pps, sps]))).toBe(true);
  });
});

describe("trimToRecentGop", () => {
  const f = (bytes: number, keyframe: boolean) => ({
    annexb: Buffer.alloc(bytes),
    keyframe,
  });

  it("leaves a buffer that fits untouched", () => {
    const pending = [f(10, true), f(10, false)];
    expect(trimToRecentGop(pending, 20, 100)).toBe(20);
    expect(pending).toHaveLength(2);
  });

  it("keeps the head and the newest GOP, dropping the middle", () => {
    // The head carries the parameter sets the decoder configures itself from,
    // so it survives even though it is the oldest thing in the buffer; the
    // middle GOP is what goes.
    const head = f(40, true);
    const newest = f(30, true);
    const pending = [head, f(10, false), f(25, true), f(10, false), newest, f(5, false)];
    expect(trimToRecentGop(pending, 120, 50)).toBe(75);
    expect(pending).toEqual([head, newest, pending[2]]);
    expect(pending[0]!.keyframe).toBe(true);
    expect(pending[1]).toBe(newest);
  });

  it("never trims to a non-keyframe, even when that means staying over the cap", () => {
    // One GOP: dropping anything after the head would leave a P-frame whose
    // references are gone. Holding the memory is the better failure.
    const pending = [f(60, true), f(20, false), f(20, false)];
    expect(trimToRecentGop(pending, 100, 50)).toBe(100);
    expect(pending).toHaveLength(3);
  });

  it("keeps the head even when every frame is a keyframe", () => {
    const pending = [f(30, true), f(30, true), f(30, true)];
    expect(trimToRecentGop(pending, 90, 50)).toBe(60);
    expect(pending).toHaveLength(2);
  });

  it("has nothing to drop when the newest keyframe is already second", () => {
    const pending = [f(40, true), f(40, true)];
    expect(trimToRecentGop(pending, 80, 50)).toBe(80);
    expect(pending).toHaveLength(2);
  });
});

describe("createAnnexbWriter", () => {
  function harness(opts: { max: number }) {
    const written: Buffer[] = [];
    let buffered = 0;
    const write = createAnnexbWriter({
      isWritable: () => true,
      bufferedBytes: () => buffered,
      write: (b) => written.push(b),
      maxBufferedBytes: opts.max,
    });
    return {
      written,
      stall: (bytes: number) => {
        buffered = bytes;
      },
      write,
    };
  }

  const P = (n: number) => ({ buf: Buffer.from([n]), keyframe: false });
  const K = (n: number) => ({ buf: Buffer.from([n]), keyframe: true });

  it("writes while ffmpeg keeps up", () => {
    const h = harness({ max: 100 });
    expect(h.write(K(1).buf, true)).toBe(true);
    expect(h.write(P(2).buf, false)).toBe(true);
    expect(h.written).toHaveLength(2);
  });

  it("resumes only at a keyframe after a back-pressure drop", () => {
    // Resuming at the next P-frame would feed the decoder a unit whose
    // references were dropped, so everything up to the next keyframe decodes as
    // garbage. Writing JPEGs, resuming immediately is correct; here it is not.
    const h = harness({ max: 100 });
    expect(h.write(K(1).buf, true)).toBe(true);

    h.stall(200);
    expect(h.write(P(2).buf, false)).toBe(false);

    h.stall(0);
    expect(h.write(P(3).buf, false)).toBe(false);
    expect(h.write(P(4).buf, false)).toBe(false);
    expect(h.write(K(5).buf, true)).toBe(true);
    expect(h.write(P(6).buf, false)).toBe(true);

    expect(h.written.map((b) => b[0])).toEqual([1, 5, 6]);
  });

  it("does not write when the pipe is gone", () => {
    const written: Buffer[] = [];
    const write = createAnnexbWriter({
      isWritable: () => false,
      bufferedBytes: () => 0,
      write: (b) => written.push(b),
    });
    expect(write(Buffer.from([1]), true)).toBe(false);
    expect(written).toHaveLength(0);
  });
});
